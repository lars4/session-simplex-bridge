import fs from "node:fs";
import path from "node:path";
import type { Subprocess } from "bun";
import { config, paths } from "./config.ts";
import { log, errMsg } from "./log.ts";

// Runs the simplex-chat CLI as a child process and talks to it over its local
// WebSocket API (https://github.com/simplex-chat/simplex-chat/tree/stable/bots).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChatResp = { type: string; [key: string]: any };

export class SimplexCommandError extends Error {
  constructor(
    public cmd: string,
    public resp: ChatResp,
  ) {
    super(`SimpleX command failed (${cmd.split(" ")[0]}): ${describeError(resp)}`);
  }
}

function describeError(resp: ChatResp): string {
  const e = resp.chatError;
  if (!e) return resp.type;
  const inner = e.storeError ?? e.errorType ?? e.agentError ?? e.chatError;
  return inner?.type ? `${e.type}/${inner.type}` : e.type;
}

type Pending = {
  resolve: (r: ChatResp) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cmd: string;
};

export class SimplexClient {
  private proc: Subprocess | undefined;
  private ws: WebSocket | undefined;
  private corrId = 0;
  private pending = new Map<string, Pending>();
  private stopped = false;
  private restartDelay = 5000;
  private connectingFor: Subprocess | undefined;

  connected = false;
  onEvent: (ev: ChatResp) => void = () => {};
  onConnected: () => void = () => {};

  /** socksProxy: "127.0.0.1:port" to route everything through Tor, with no direct fallback. */
  constructor(
    private dbKey: string,
    private socksProxy?: string,
  ) {}

  start() {
    this.spawn();
  }

  async stop() {
    this.stopped = true;
    this.ws?.close();
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      await Promise.race([this.proc.exited, Bun.sleep(5000)]);
      if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    }
  }

  private spawn() {
    if (this.stopped) return;
    if (!fs.existsSync(config.simplexBin)) {
      log.error(`simplex-chat not found at ${config.simplexBin}. Run install.sh first.`);
      this.scheduleRespawn();
      return;
    }
    const args = [
      config.simplexBin,
      "-p", String(config.simplexPort),
      "-d", paths.simplexDb,
      "-k", this.dbKey,
      "-y",
      "--create-bot-display-name", config.simplexBotName,
      "--create-bot-allow-files",
      "--files-folder", paths.simplexFiles,
      "--temp-folder", paths.simplexTmp,
    ];
    if (this.socksProxy) {
      // All SMP/XFTP connections via Tor; prefer relays' .onion addresses.
      args.push("--socks-proxy", this.socksProxy, "--socks-mode", "always", "--host-mode", "onion");
    }
    log.info("Starting SimpleX CLI");
    // bin/lib holds the OpenSSL library install.sh bundles when Homebrew isn't installed.
    const libDir = path.join(path.dirname(config.simplexBin), "lib");
    const env = { ...process.env, DYLD_FALLBACK_LIBRARY_PATH: libDir };
    const proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
    this.proc = proc;
    this.pipeOutput(proc.stdout as ReadableStream<Uint8Array>, "out");
    this.pipeOutput(proc.stderr as ReadableStream<Uint8Array>, "err");
    proc.exited.then((code) => {
      if (this.proc !== proc) return;
      if (!this.stopped) log.warn(`SimpleX CLI exited with code ${code}`);
      this.setDisconnected(new Error("SimpleX CLI exited"));
      this.scheduleRespawn();
    });
    void this.connectLoop(proc);
  }

  private scheduleRespawn() {
    if (this.stopped) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 5 * 60 * 1000);
    log.info(`Restarting SimpleX CLI in ${Math.round(delay / 1000)}s`);
    setTimeout(() => this.spawn(), delay);
  }

  private async pipeOutput(stream: ReadableStream<Uint8Array>, kind: string) {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of stream) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) log.info(`[simplex ${kind}]`, line.slice(0, 400));
        }
      }
    } catch {}
  }

  private async connectLoop(proc: Subprocess) {
    if (this.connectingFor === proc) return;
    this.connectingFor = proc;
    try {
      for (let attempt = 0; !this.stopped && this.proc === proc && proc.exitCode === null; attempt++) {
        try {
          await this.openSocket();
          this.restartDelay = 5000;
          return;
        } catch {
          await Bun.sleep(attempt < 30 ? 1000 : 5000);
        }
      }
    } finally {
      if (this.connectingFor === proc) this.connectingFor = undefined;
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${config.simplexPort}`);
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.ws = ws;
        this.connected = true;
        log.info("Connected to SimpleX CLI");
        resolve();
        try {
          this.onConnected();
        } catch (e) {
          log.error("onConnected handler failed:", errMsg(e));
        }
      };
      ws.onmessage = (e) => this.handleMessage(String(e.data));
      ws.onerror = () => {
        if (!opened) reject(new Error("WebSocket error"));
      };
      ws.onclose = () => {
        if (!opened) return reject(new Error("WebSocket closed"));
        if (this.ws !== ws) return;
        if (!this.stopped) log.warn("Lost connection to SimpleX CLI");
        this.setDisconnected(new Error("SimpleX connection closed"));
        if (this.proc) void this.connectLoop(this.proc);
      };
    });
  }

  private setDisconnected(err: Error) {
    this.connected = false;
    this.ws = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private handleMessage(data: string) {
    let msg: { corrId?: string; resp?: ChatResp };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const resp = msg.resp;
    if (!resp || typeof resp.type !== "string") return;
    if (msg.corrId && this.pending.has(msg.corrId)) {
      const p = this.pending.get(msg.corrId)!;
      this.pending.delete(msg.corrId);
      clearTimeout(p.timer);
      if (resp.type === "chatCmdError" || resp.type === "chatError") {
        p.reject(new SimplexCommandError(p.cmd, resp));
      } else {
        p.resolve(resp);
      }
      return;
    }
    try {
      this.onEvent(resp);
    } catch (e) {
      log.error(`Handling SimpleX event ${resp.type} failed:`, errMsg(e));
    }
  }

  cmd(cmd: string, timeoutMs = 120_000): Promise<ChatResp> {
    const ws = this.ws;
    if (!ws || !this.connected) return Promise.reject(new Error("SimpleX not connected"));
    const corrId = String(++this.corrId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(corrId);
        reject(new Error(`SimpleX command timed out (${cmd.split(" ")[0]})`));
      }, timeoutMs);
      this.pending.set(corrId, { resolve, reject, timer, cmd });
      ws.send(JSON.stringify({ corrId, cmd }));
    });
  }

  // ---- Typed helpers for the commands the bridge uses ----

  async activeUserId(): Promise<number> {
    const r = await this.cmd("/user");
    return r.user.userId;
  }

  async createInvitation(userId: number) {
    const r = await this.cmd(`/_connect ${userId}`);
    const link: string = r.connLinkInvitation.connShortLink ?? r.connLinkInvitation.connFullLink;
    return {
      link,
      connId: r.connection.pccConnId as number,
      agentConnId: r.connection.pccAgentConnId as string,
    };
  }

  /** Sends one message to a contact; returns the SimpleX chat item id of the sent message. */
  async sendToContact(
    contactId: number,
    msg: { text: string; filePath?: string; quotedItemId?: number },
  ): Promise<{ itemId?: number; fileId?: number }> {
    const composed = {
      ...(msg.filePath && { fileSource: { filePath: msg.filePath } }),
      ...(msg.quotedItemId !== undefined && { quotedItemId: msg.quotedItemId }),
      msgContent: msg.filePath ? { type: "file", text: msg.text } : { type: "text", text: msg.text },
      mentions: {},
    };
    const r = await this.cmd(`/_send @${contactId} json ${JSON.stringify([composed])}`);
    const ci = r.chatItems?.[0]?.chatItem;
    return { itemId: ci?.meta?.itemId, fileId: ci?.file?.fileId };
  }

  async react(contactId: number, itemId: number, emoji: string) {
    await this.cmd(
      `/_reaction @${contactId} ${itemId} on ${JSON.stringify({ type: "emoji", emoji })}`,
    );
  }

  async receiveFile(fileId: number) {
    await this.cmd(`/freceive ${fileId} approved_relays=on encrypt=off`);
  }
}

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Subprocess } from "bun";
import { config, paths } from "./config.ts";
import { log } from "./log.ts";

// Runs the bundled tor binary as a child process (or uses an existing Tor via
// TOR_SOCKS) and tracks whether it is ready. Everything else in the bridge only
// talks to the network through this Tor.

export class Tor {
  readonly socks: { host: string; port: number };
  ready = false;
  progress = 0;
  private proc: Subprocess | undefined;
  private stopped = false;
  private restartDelay = 5000;
  private waiters: (() => void)[] = [];
  readonly external: boolean;

  constructor() {
    if (config.torExternalSocks) {
      const [host, port] = config.torExternalSocks.replace(/^socks5h?:\/\//, "").split(":");
      this.socks = { host: host || "127.0.0.1", port: Number(port) };
      this.external = true;
    } else {
      this.socks = { host: "127.0.0.1", port: config.torSocksPort };
      this.external = false;
    }
  }

  start() {
    if (this.external) void this.watchExternal();
    else this.spawn();
  }

  /** Resolves once Tor has a working circuit (bootstrapped 100%). */
  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  status(): string {
    const where = this.external ? `existing Tor at ${this.socks.host}:${this.socks.port}` : "bundled Tor";
    return this.ready ? `Tor ✅ (${where})` : `Tor connecting… ${this.progress}% (${where})`;
  }

  async stop() {
    this.stopped = true;
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      await Promise.race([this.proc.exited, Bun.sleep(5000)]);
      if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    }
  }

  private setReady(ready: boolean) {
    if (ready === this.ready) return;
    this.ready = ready;
    if (ready) {
      log.info("Tor is ready");
      this.waiters.splice(0).forEach((r) => r());
    } else if (!this.stopped) {
      log.warn("Tor is not available. All traffic is paused until it is back.");
    }
  }

  private spawn() {
    if (this.stopped) return;
    if (!fs.existsSync(config.torBin)) {
      log.error(`tor not found at ${config.torBin}. Run install.sh again (or set BRIDGE_TOR=off).`);
      return this.scheduleRespawn();
    }
    fs.mkdirSync(paths.torData, { recursive: true, mode: 0o700 });
    fs.chmodSync(paths.torData, 0o700);
    const bundleRoot = path.resolve(path.dirname(config.torBin), "..");
    const args = [
      config.torBin,
      "--defaults-torrc", "/dev/null",
      "-f", "/dev/null",
      "--ignore-missing-torrc",
      "--SocksPort", `${this.socks.host}:${this.socks.port} IsolateSOCKSAuth`,
      "--DataDirectory", paths.torData,
      "--ClientOnly", "1",
      "--AvoidDiskWrites", "1",
      "--Log", "notice stdout",
      // Tor exits on its own if the bridge dies.
      "--__OwningControllerProcess", String(process.pid),
    ];
    for (const [opt, file] of [["--GeoIPFile", "geoip"], ["--GeoIPv6File", "geoip6"]]) {
      const p = path.join(bundleRoot, "data", file);
      if (fs.existsSync(p)) args.push(opt, p);
    }
    log.info("Starting Tor");
    this.progress = 0;
    const proc = Bun.spawn(args, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DYLD_FALLBACK_LIBRARY_PATH: path.dirname(config.torBin) },
    });
    this.proc = proc;
    void this.readLog(proc.stdout as ReadableStream<Uint8Array>);
    void this.readLog(proc.stderr as ReadableStream<Uint8Array>);
    proc.exited.then((code) => {
      if (this.proc !== proc) return;
      this.setReady(false);
      if (!this.stopped) log.warn(`Tor exited with code ${code}`);
      this.scheduleRespawn();
    });
  }

  private scheduleRespawn() {
    if (this.stopped) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 5 * 60 * 1000);
    log.info(`Restarting Tor in ${Math.round(delay / 1000)}s`);
    setTimeout(() => this.spawn(), delay);
  }

  private async readLog(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of stream) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const m = /Bootstrapped (\d+)%/.exec(line);
          if (m) {
            this.progress = Number(m[1]);
            if (this.progress === 100) {
              this.restartDelay = 5000;
              this.setReady(true);
            }
          }
          if (m || /\[(warn|err)\]/.test(line)) log.info("[tor]", line.replace(/^.*?\[/, "[").slice(0, 300));
        }
      }
    } catch {}
  }

  /** External Tor: we can't see its bootstrap, so treat "SOCKS port accepts connections" as ready. */
  private async watchExternal() {
    while (!this.stopped) {
      const ok = await new Promise<boolean>((resolve) => {
        const s = net.connect(this.socks.port, this.socks.host);
        s.setTimeout(5000);
        s.once("connect", () => (s.destroy(), resolve(true)));
        s.once("error", () => resolve(false));
        s.once("timeout", () => (s.destroy(), resolve(false)));
      });
      this.progress = ok ? 100 : 0;
      this.setReady(ok);
      await Bun.sleep(ok ? 30_000 : 5_000);
    }
  }
}

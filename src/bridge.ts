import fs from "node:fs";
import path from "node:path";
import type { Session, Poller } from "@session.js/client";
import { config, paths } from "./config.ts";
import { log, errMsg, shortId } from "./log.ts";
import {
  store,
  type InboundItem,
  type OutboundItem,
  type Ref,
  type SerializedAttachment,
} from "./store.ts";
import { SimplexClient, type ChatResp } from "./simplex.ts";

// Session's file server rejects attachments above 10 MB.
const SESSION_MAX_FILE = 10 * 1024 * 1024;
const MAX_DOWNLOAD_TRIES = 5;

// The parts of a Session.js message the bridge uses.
type SessionMessage = {
  id: string;
  type: "private" | "group";
  groupId?: string;
  from: string;
  author?: { displayName?: string };
  text?: string;
  attachments: {
    id: string;
    caption?: string;
    metadata: { width?: number; height?: number; contentType?: string };
    size?: number;
    name?: string;
    _key?: Uint8Array;
    _digest?: Uint8Array;
  }[];
  replyToMessage?: { text?: string };
  timestamp: number;
};

const HELP = [
  "How to use this chat",
  "",
  "• Messages sent to your Session ID appear here, labelled with the sender.",
  "• To reply to someone: quote (swipe on) one of their messages and write your answer.",
  "• A message without a quote goes to the current chat (see /who).",
  "• Files, photos and voice messages work in both directions (max 10 MB to Session).",
  "• ✅ on your message = delivered to Session.",
  "",
  "/to <name or Session ID> [text] – switch the current chat (and send)",
  "/who – show the current chat",
  "/list – Session contacts the bridge knows",
  "/name <name> <new name> – rename a contact",
  "/id – the Session ID people can write to",
  "/status – queue and connection status",
  "/help – this text",
  "",
  "To send a message that starts with /, write // instead.",
].join("\n");

export class Bridge {
  private stopped = false;
  private userId: number | undefined;
  private pumpingSimplex = false;
  private pumpingSession = false;
  private lastPollOk = 0;
  private lastPollError: string | undefined;
  private mySessionId: string;

  constructor(
    private simplex: SimplexClient,
    private session: Session,
    private poller: Poller,
    private network: { isReady: () => boolean; status: () => string } = {
      isReady: () => true,
      status: () => "direct",
    },
  ) {
    this.mySessionId = session.getSessionID();
  }

  start() {
    this.simplex.onEvent = (ev) => this.onSimplexEvent(ev);
    this.simplex.onConnected = () => void this.onSimplexConnected();
    this.session.on("message", (m) => this.onSessionMessage(m as unknown as SessionMessage));
    this.cleanupOldFiles();
    this.simplex.start();
    void this.pollLoop();
    setInterval(() => {
      void this.pumpToSimplex();
      void this.pumpToSession();
    }, 10_000);
  }

  stop() {
    this.stopped = true;
  }

  // ---------------------------------------------------------------- Session side

  private async pollLoop() {
    let delay = config.pollIntervalMs;
    while (!this.stopped) {
      if (!this.network.isReady()) {
        await Bun.sleep(2000);
        continue;
      }
      try {
        await this.poller.poll();
        if (this.lastPollError) log.info("Session polling works again");
        this.lastPollOk = Date.now();
        this.lastPollError = undefined;
        delay = config.pollIntervalMs;
      } catch (e) {
        const msg = errMsg(e);
        if (msg !== this.lastPollError) log.warn("Session poll failed:", msg);
        this.lastPollError = msg;
        delay = Math.min(Math.max(delay * 2, 10_000), 120_000);
      }
      await Bun.sleep(delay);
    }
  }

  private onSessionMessage(m: SessionMessage) {
    if (m.from === this.mySessionId) return;
    const groupId = m.type === "group" ? m.groupId : undefined;
    const newContact = !store.state.contacts[m.from];
    this.touchContact(m.from, m.author?.displayName);
    if (!store.state.active && !groupId) store.state.active = m.from;

    const item: InboundItem = {
      hash: m.id,
      from: m.from,
      groupId,
      displayName: cleanName(m.author?.displayName, m.from),
      timestamp: m.timestamp,
      text: m.text,
      quoteText: m.replyToMessage?.text,
      attachments: m.attachments.map(serializeAttachment),
      tries: 0,
      receivedAt: Date.now(),
      newContact,
    };
    store.state.toSimplex.push(item);
    store.flush(); // persist right away so a crash can't lose it
    log.info(
      `Session message from ${shortId(m.from)}${groupId ? " (group)" : ""}` +
        `${item.attachments.length ? `, ${item.attachments.length} attachment(s)` : ""}`,
    );
    void this.pumpToSimplex();
  }

  private touchContact(sessionId: string, displayName?: string) {
    const c = store.state.contacts[sessionId];
    const name = cleanName(displayName, sessionId);
    if (c) {
      c.lastSeen = Date.now();
      if (name) c.displayName = name;
    } else {
      const now = Date.now();
      store.state.contacts[sessionId] = {
        alias: this.makeAlias(name, sessionId),
        displayName: name,
        firstSeen: now,
        lastSeen: now,
      };
    }
    store.save();
  }

  private makeAlias(name: string | undefined, sessionId: string) {
    let base = (name ?? "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 16);
    if (!base) base = "s" + sessionId.slice(2, 6);
    const taken = new Set(Object.values(store.state.contacts).map((c) => c.alias));
    let alias = base;
    for (let n = 2; taken.has(alias); n++) alias = `${base}${n}`;
    return alias;
  }

  private label(sessionId: string) {
    const c = store.state.contacts[sessionId];
    if (!c) return shortId(sessionId);
    return c.displayName ? `${c.displayName} (${c.alias})` : c.alias;
  }

  // ---------------------------------------------------------------- SimpleX side

  private setupBusy = false;
  private setupRetry: ReturnType<typeof setTimeout> | undefined;

  private async onSimplexConnected() {
    if (this.setupBusy) return;
    this.setupBusy = true;
    clearTimeout(this.setupRetry);
    try {
      this.userId = await this.simplex.activeUserId();
      if (!store.state.owner) await this.ensureInvitation();
      void this.pumpToSimplex();
      void this.pumpToSession();
    } catch (e) {
      log.error("SimpleX setup failed, retrying in 60s:", errMsg(e));
      this.setupRetry = setTimeout(() => {
        if (!this.stopped && this.simplex.connected) void this.onSimplexConnected();
      }, 60_000);
    } finally {
      this.setupBusy = false;
    }
  }

  private async ensureInvitation() {
    if (!store.state.invitation) {
      const inv = await this.simplex.createInvitation(this.userId!);
      store.state.invitation = { ...inv, createdAt: Date.now() };
      store.flush();
    }
    fs.writeFileSync(paths.pairingLink, store.state.invitation.link + "\n", { mode: 0o600 });
    log.info(
      "Not paired yet. Open the pairing link in SimpleX (from your hidden profile). " +
        "Show it as a QR code with: bun run pair",
    );
  }

  private onSimplexEvent(ev: ChatResp) {
    switch (ev.type) {
      case "contactConnected":
      case "contactSndReady":
        this.maybeClaimOwner(ev.contact);
        break;
      case "newChatItems":
        for (const aci of ev.chatItems ?? []) void this.onChatItem(aci);
        break;
      case "rcvFileComplete":
        void this.onOwnerFileComplete(ev.chatItem);
        break;
      case "rcvFileError":
      case "rcvFileSndCancelled":
        this.onOwnerFileFailed(ev.chatItem, ev.type);
        break;
      case "sndFileCompleteXFTP":
      case "sndFileError":
        this.forgetSentFile(ev.chatItem?.chatItem?.file?.fileId);
        break;
      case "contactDeletedByContact":
        if (ev.contact?.contactId === store.state.owner?.contactId) {
          log.warn("You deleted the bridge chat in SimpleX. Creating a new pairing link.");
          store.state.owner = undefined;
          store.state.invitation = undefined;
          store.flush();
          void this.ensureInvitation().catch((e) => log.error(errMsg(e)));
        }
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private maybeClaimOwner(contact: any) {
    const inv = store.state.invitation;
    if (store.state.owner || !inv || !contact) return;
    const conn = contact.activeConn;
    if (!conn || (conn.connId !== inv.connId && conn.agentConnId !== inv.agentConnId)) return;
    store.state.owner = { contactId: contact.contactId, pairedAt: Date.now() };
    store.state.invitation = undefined;
    store.flush();
    try {
      fs.rmSync(paths.pairingLink, { force: true });
    } catch {}
    log.info("Paired with your SimpleX profile");
    this.notify(
      `Paired ✅\n\nThis chat now receives everything sent to this Session ID:\n${this.mySessionId}\n\n${HELP}`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onChatItem(aci: any) {
    const owner = store.state.owner;
    const info = aci?.chatInfo;
    const ci = aci?.chatItem;
    if (!owner || info?.type !== "direct" || info.contact?.contactId !== owner.contactId) return;
    if (ci?.chatDir?.type !== "directRcv" || ci?.content?.type !== "rcvMsgContent") return;
    try {
      await this.onOwnerMessage(ci);
    } catch (e) {
      log.error("Handling your SimpleX message failed:", errMsg(e));
      this.notify(`⚠️ Something went wrong: ${errMsg(e)}`, ci.meta?.itemId);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onOwnerMessage(ci: any) {
    const itemId: number = ci.meta.itemId;
    const mc = ci.content.msgContent ?? {};
    let text: string = (mc.text ?? "").trim();
    const hasFile = !!ci.file;

    if (!hasFile && text.startsWith("/") && !text.startsWith("//")) {
      return this.onCommand(text, itemId);
    }
    if (text.startsWith("//")) text = text.slice(1);

    // Who is this for? A quoted forwarded message wins, otherwise the current chat.
    let to = store.state.active;
    let quote: OutboundItem["quote"];
    const quotedId = ci.quotedItem?.itemId;
    const ref: Ref | undefined = quotedId !== undefined ? store.state.refs[String(quotedId)] : undefined;
    if (ref) {
      if (ref.groupId) {
        return this.notify("Replying to Session groups isn't supported, only to direct chats.", itemId);
      }
      to = ref.sessionId;
      quote = { timestamp: ref.timestamp, author: ref.sessionId, text: ref.text };
      this.setActive(to);
    }
    if (!to) {
      return this.notify(
        "Who should get this? Quote (swipe on) a forwarded message, or use /to <name>.",
        itemId,
      );
    }

    if (hasFile) {
      const fileId: number = ci.file.fileId;
      store.state.pendingOwnerFiles[String(fileId)] = {
        ownerItemId: itemId,
        to,
        text: text || undefined,
        msgType: mc.type ?? "file",
        fileName: ci.file.fileName ?? "file",
        quote,
        requestedAt: Date.now(),
      };
      store.save();
      await this.simplex.receiveFile(fileId);
      return;
    }
    if (!text) return;
    this.enqueueToSession({ ownerItemId: itemId, to, text, files: [], quote });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onOwnerFileComplete(aci: any) {
    const ci = aci?.chatItem;
    const fileId = ci?.file?.fileId;
    const p = fileId !== undefined ? store.state.pendingOwnerFiles[String(fileId)] : undefined;
    if (!p) return;
    delete store.state.pendingOwnerFiles[String(fileId)];
    store.save();

    const stored: string | undefined = ci.file.fileSource?.filePath;
    if (!stored) return this.notify("⚠️ Couldn't find the received file.", p.ownerItemId);
    const filePath = path.isAbsolute(stored) ? stored : path.join(paths.simplexFiles, stored);
    const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (size > SESSION_MAX_FILE) {
      safeRm(filePath);
      return this.notify("⚠️ Not sent: Session only accepts files up to 10 MB.", p.ownerItemId);
    }
    this.enqueueToSession({
      ownerItemId: p.ownerItemId,
      to: p.to,
      text: p.text,
      files: [{ path: filePath, name: p.fileName, contentType: guessType(p.fileName, p.msgType) }],
      voice: p.msgType === "voice",
      quote: p.quote,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onOwnerFileFailed(aci: any, why: string) {
    const fileId = aci?.chatItem?.file?.fileId;
    const p = fileId !== undefined ? store.state.pendingOwnerFiles[String(fileId)] : undefined;
    if (!p) return;
    delete store.state.pendingOwnerFiles[String(fileId)];
    store.save();
    log.warn(`Receiving your file failed (${why})`);
    this.notify("⚠️ The bridge couldn't download this file, so it wasn't sent.", p.ownerItemId);
  }

  private forgetSentFile(fileId: number | undefined) {
    if (fileId === undefined) return;
    const p = store.state.sentFiles[String(fileId)];
    if (!p) return;
    safeRm(p);
    delete store.state.sentFiles[String(fileId)];
    store.save();
  }

  // ---------------------------------------------------------------- commands

  private onCommand(text: string, itemId: number) {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    switch (cmd) {
      case "/help":
      case "/start":
        return this.notify(HELP);
      case "/id":
        return this.notify(`People can write to this Session ID:\n${this.mySessionId}`);
      case "/who": {
        const a = store.state.active;
        return this.notify(a ? `Current chat: ${this.label(a)}\n${a}` : "No current chat. Use /to <name>.");
      }
      case "/list": {
        const list = Object.entries(store.state.contacts)
          .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
          .map(([id, c]) => `${id === store.state.active ? "▶" : "•"} ${c.alias}${c.displayName ? ` – ${c.displayName}` : ""} (${shortId(id)})`);
        return this.notify(list.length ? list.join("\n") : "No Session contacts yet.");
      }
      case "/to": {
        const target = rest[0];
        if (!target) return this.notify("Usage: /to <name or Session ID> [message]");
        const id = this.resolveContact(target);
        if (!id) return this.notify(`No contact matches "${target}". See /list, or use a full Session ID.`);
        this.setActive(id);
        const body = text.slice(cmdRaw.length).trimStart().slice(target.length).trim();
        if (body) this.enqueueToSession({ ownerItemId: itemId, to: id, text: body, files: [] });
        else this.notify(`Current chat: ${this.label(id)}`);
        return;
      }
      case "/name": {
        const [who, ...nameParts] = rest;
        const newAlias = nameParts.join("").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!who || !newAlias) return this.notify("Usage: /name <name> <new name>");
        const id = this.resolveContact(who);
        if (!id) return this.notify(`No contact matches "${who}".`);
        const clash = Object.entries(store.state.contacts).find(([k, c]) => c.alias === newAlias && k !== id);
        if (clash) return this.notify(`"${newAlias}" is already used.`);
        store.state.contacts[id].alias = newAlias;
        store.save();
        return this.notify(`Renamed to ${newAlias}.`);
      }
      case "/status": {
        const s = store.state;
        const poll = this.lastPollOk ? `${Math.round((Date.now() - this.lastPollOk) / 1000)}s ago` : "not yet";
        return this.notify(
          [
            `Session ID: ${shortId(this.mySessionId)}`,
            `Network: ${this.network.status()}`,
            `Last successful Session check: ${poll}${this.lastPollError ? ` (last error: ${this.lastPollError})` : ""}`,
            `Waiting to forward here: ${s.toSimplex.length}`,
            `Waiting to send to Session: ${s.toSession.length}`,
            `Current chat: ${s.active ? this.label(s.active) : "none"}`,
          ].join("\n"),
        );
      }
      default:
        return this.notify(`Unknown command ${cmd}. Send /help, or start with // to send a literal "/".`);
    }
  }

  private resolveContact(q: string): string | undefined {
    const query = q.toLowerCase().replace(/^@/, "");
    if (/^05[0-9a-f]{64}$/.test(query)) {
      if (!store.state.contacts[query]) this.touchContact(query);
      return query;
    }
    const entries = Object.entries(store.state.contacts);
    const exact = entries.find(([, c]) => c.alias === query);
    if (exact) return exact[0];
    if (query.length < 3) return undefined;
    const matches = entries.filter(
      ([id, c]) =>
        c.alias.startsWith(query) ||
        id.startsWith(query) ||
        (c.displayName ?? "").toLowerCase().startsWith(query),
    );
    return matches.length === 1 ? matches[0][0] : undefined;
  }

  private setActive(sessionId: string) {
    if (store.state.active === sessionId) return;
    store.state.active = sessionId;
    store.save();
  }

  // ---------------------------------------------------------------- queues

  private notify(text: string, quotedItemId?: number) {
    const owner = store.state.owner;
    if (!owner || !this.simplex.connected) {
      log.info("Owner notice not delivered (SimpleX not ready)");
      return;
    }
    this.simplex
      .sendToContact(owner.contactId, { text, quotedItemId })
      .catch((e) => log.warn("Could not send notice:", errMsg(e)));
  }

  private enqueueToSession(item: Omit<OutboundItem, "id" | "createdAt" | "tries" | "nextAt">) {
    store.state.toSession.push({
      ...item,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      tries: 0,
      nextAt: 0,
    });
    store.flush();
    void this.pumpToSession();
  }

  /** Forward queued Session messages to your SimpleX profile, oldest first. */
  private async pumpToSimplex() {
    const owner = store.state.owner;
    if (this.pumpingSimplex || !owner || !this.simplex.connected) return;
    this.pumpingSimplex = true;
    try {
      while (store.state.toSimplex.length && this.simplex.connected && !this.stopped) {
        const item = store.state.toSimplex[0];
        if (!item.downloaded) {
          const ok = await this.downloadAttachments(item);
          if (!ok) break; // retry later, keep order
        }
        await this.forward(owner.contactId, item);
        store.state.toSimplex.shift();
        store.flush();
      }
    } catch (e) {
      log.warn("Forwarding to SimpleX failed, will retry:", errMsg(e));
    } finally {
      this.pumpingSimplex = false;
    }
  }

  private async downloadAttachments(item: InboundItem): Promise<boolean> {
    const downloaded: { path: string; name: string }[] = [];
    let failed = 0;
    for (const att of item.attachments) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const file: File = await this.session.getFile(deserializeAttachment(att) as any);
        const name = safeName(file.name || att.name || `attachment-${att.id}`);
        const p = path.join(paths.incoming, `${crypto.randomUUID().slice(0, 8)}-${name}`);
        await Bun.write(p, file);
        fs.chmodSync(p, 0o600);
        downloaded.push({ path: p, name });
      } catch (e) {
        failed++;
        log.warn("Attachment download failed:", errMsg(e));
      }
    }
    if (failed && item.tries + 1 < MAX_DOWNLOAD_TRIES) {
      item.tries++;
      downloaded.forEach((d) => safeRm(d.path));
      store.save();
      return false;
    }
    item.downloaded = downloaded;
    item.failedAttachments = failed;
    store.save();
    return true;
  }

  private async forward(ownerContactId: number, item: InboundItem) {
    const ref: Ref = {
      sessionId: item.from,
      groupId: item.groupId,
      timestamp: item.timestamp,
      text: item.text?.slice(0, 200),
    };
    const lines = [this.header(item)];
    if (item.quoteText) lines.push(`> ${oneLine(item.quoteText).slice(0, 120)}`);
    if (item.text) lines.push(item.text);
    const files = item.downloaded ?? [];
    if (!item.text && files.length) lines.push(`📎 ${files.length} attachment${files.length > 1 ? "s" : ""}`);
    if (item.failedAttachments) lines.push(`⚠️ ${item.failedAttachments} attachment(s) could not be downloaded`);

    const sent = await this.simplex.sendToContact(ownerContactId, { text: lines.join("\n") });
    if (sent.itemId !== undefined) store.addRef(sent.itemId, ref);

    for (const f of files) {
      const r = await this.simplex.sendToContact(ownerContactId, { text: "", filePath: f.path });
      if (r.itemId !== undefined) store.addRef(r.itemId, ref);
      if (r.fileId !== undefined) store.state.sentFiles[String(r.fileId)] = f.path;
    }
    store.save();
  }

  private header(item: InboundItem) {
    const c = store.state.contacts[item.from];
    const who = c?.displayName ? `*${c.displayName}* · ${c.alias}` : `*${c?.alias ?? shortId(item.from)}*`;
    const prefix = item.groupId ? `👥 ${shortId(item.groupId)} – ` : "";
    const hint =
      item.groupId || item.from === store.state.active ? "" : "  ↩︎ quote to reply";
    return `${prefix}${who}${item.newContact ? " 🆕" : ""}${hint}`;
  }

  /** Send queued replies to Session, retrying with backoff while offline. */
  private async pumpToSession() {
    if (this.pumpingSession || !this.network.isReady()) return;
    this.pumpingSession = true;
    try {
      const now = Date.now();
      for (const item of [...store.state.toSession]) {
        if (this.stopped) break;
        if (item.nextAt > now) continue;
        try {
          await this.sendToSession(item);
          this.removeOutbound(item);
          item.files.forEach((f) => safeRm(f.path));
          this.touchContact(item.to);
          this.react(item.ownerItemId, "✅");
        } catch (e) {
          const msg = errMsg(e);
          const permanent =
            /validation/i.test((e as Error)?.name ?? "") ||
            /invalid session id|must be a hex|attachment size|must be instances of file/i.test(msg);
          item.tries++;
          if (permanent || now - item.createdAt > config.sendGiveUpMs) {
            log.warn("Giving up sending to Session:", msg);
            this.removeOutbound(item);
            item.files.forEach((f) => safeRm(f.path));
            this.notify(`⚠️ Not delivered to ${this.label(item.to)}: ${msg}`, item.ownerItemId);
          } else {
            item.nextAt = now + Math.min(30_000 * 2 ** (item.tries - 1), 10 * 60_000);
            if (item.tries === 1) log.warn("Sending to Session failed, will retry:", msg);
          }
          store.save();
        }
      }
    } finally {
      this.pumpingSession = false;
    }
  }

  private async sendToSession(item: OutboundItem) {
    const files: File[] = [];
    for (const f of item.files) {
      const data = await Bun.file(f.path).arrayBuffer();
      files.push(new File([data], f.name, { type: f.contentType }));
    }
    if (item.voice && files[0]) {
      await this.session.sendMessage({ to: item.to, voiceMessage: files[0] });
      if (item.text) await this.session.sendMessage({ to: item.to, text: item.text });
      return;
    }
    await this.session.sendMessage({
      to: item.to,
      ...(item.text && { text: item.text }),
      ...(files.length && { attachments: files }),
      ...(item.quote && { replyToMessage: item.quote }),
    });
  }

  private removeOutbound(item: OutboundItem) {
    store.state.toSession = store.state.toSession.filter((i) => i.id !== item.id);
    store.flush();
  }

  private react(itemId: number, emoji: string) {
    const owner = store.state.owner;
    if (!owner || !this.simplex.connected) return;
    this.simplex.react(owner.contactId, itemId, emoji).catch(() => {});
  }

  /** Remove leftovers older than two weeks (e.g. after a crash mid-transfer). */
  private cleanupOldFiles() {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const keep = new Set([
      ...Object.values(store.state.sentFiles),
      ...store.state.toSession.flatMap((i) => i.files.map((f) => f.path)),
      ...store.state.toSimplex.flatMap((i) => (i.downloaded ?? []).map((d) => d.path)),
    ]);
    for (const dir of [paths.incoming, paths.simplexFiles]) {
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const p = path.join(dir, name);
        try {
          const st = fs.statSync(p);
          if (st.isFile() && st.mtimeMs < cutoff && !keep.has(p)) fs.rmSync(p);
        } catch {}
      }
    }
  }
}

// ---------------------------------------------------------------- helpers

function cleanName(name: string | undefined, sessionId: string): string | undefined {
  if (!name) return undefined;
  const n = name.replace(/[\r\n*_~`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  // Session.js fills in "(05ab...cd12)" when the sender has no display name.
  if (!n || n === `(${sessionId.slice(0, 4)}...${sessionId.slice(-4)})`) return undefined;
  return n;
}

function oneLine(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function safeName(name: string) {
  return name.replace(/[/\\:\0]/g, "_").replace(/^\.+/, "_").slice(0, 100) || "file";
}

function safeRm(p: string) {
  try {
    fs.rmSync(p, { force: true });
  } catch {}
}

function b64(u?: Uint8Array) {
  return u ? Buffer.from(u).toString("base64") : undefined;
}

function serializeAttachment(a: SessionMessage["attachments"][number]): SerializedAttachment {
  return {
    id: a.id,
    name: a.name,
    size: a.size,
    caption: a.caption,
    contentType: a.metadata?.contentType,
    width: a.metadata?.width,
    height: a.metadata?.height,
    key: b64(a._key),
    digest: b64(a._digest),
  };
}

function deserializeAttachment(a: SerializedAttachment) {
  return {
    id: a.id,
    name: a.name,
    size: a.size,
    caption: a.caption,
    metadata: { contentType: a.contentType, width: a.width, height: a.height },
    _key: a.key ? new Uint8Array(Buffer.from(a.key, "base64")) : undefined,
    _digest: a.digest ? new Uint8Array(Buffer.from(a.digest, "base64")) : undefined,
  };
}

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  txt: "text/plain",
  zip: "application/zip",
};

function guessType(fileName: string, msgType: string) {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (MIME[ext]) return MIME[ext];
  if (msgType === "image") return "image/jpeg";
  if (msgType === "voice") return "audio/mp4";
  if (msgType === "video") return "video/mp4";
  return "application/octet-stream";
}

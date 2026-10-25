import fs from "node:fs";
import { ok, sleep, done } from "./util.ts";
import { FakeSession, FakePoller } from "./fakes.ts";

// A short poll interval so the retry test below doesn't take long.
process.env.POLL_INTERVAL_MS = "100";
const { ensureDirs, paths } = await import("../src/config.ts");
const { store } = await import("../src/store.ts");
const { Bridge } = await import("../src/bridge.ts");
const { Health } = await import("../src/health.ts");
ensureDirs();
store.load();

let nextItem = 100, nextFile = 500;
const sent: any[] = [];
const cmds: string[] = [];
const fakeSimplex: any = {
  connected: true, onEvent: null, onConnected: null,
  start() {}, async activeUserId() { return 1; },
  async createInvitation() { return { link: "https://smp.example/i#test", connId: 42, agentConnId: "agent42" }; },
  async sendToContact(c: number, m: any) { const it = { itemId: nextItem++, fileId: m.filePath ? nextFile++ : undefined }; sent.push({ c, ...m, ...it }); return it; },
  async react(c: number, i: number, e: string) { cmds.push(`react ${i} ${e}`); },
  async receiveFile(id: number) { cmds.push(`freceive ${id}`); },
};
const session: any = new FakeSession();
const poller = new FakePoller();
let circuits = 0;
let torUp = true;
const bridge: any = new Bridge(fakeSimplex, session as any, poller as any, {
  isReady: () => torUp,
  status: () => (torUp ? "Tor ✅ (test)" : "Tor connecting… 40% (test)"),
  newCircuit: () => void circuits++,
});
bridge.start();
const tick = () => sleep(60);

// 1. connect → invitation
await fakeSimplex.onConnected(); await tick();
ok(fs.readFileSync(paths.pairingLink, "utf8").includes("smp.example"), "pairing link written");

// 2. a Session message arrives before pairing → queued
const ANNA = "05" + "b".repeat(64), BEN = "05" + "c".repeat(64);
session.emit("message", { id: "m1", type: "private", from: ANNA, author: { displayName: "Anna Müller" }, text: "Hi there", attachments: [], timestamp: 1000 });
await tick();
ok(store.state.toSimplex.length === 1 && sent.length === 0, "message queued while unpaired");

// 3. a different contact connecting must not become owner
fakeSimplex.onEvent({ type: "contactConnected", contact: { contactId: 2, activeConn: { connId: 7, agentConnId: "x" } } });
ok(!store.state.owner, "foreign contact not accepted as owner");
fakeSimplex.onEvent({ type: "contactConnected", contact: { contactId: 9, activeConn: { connId: 42, agentConnId: "agent42" } } });
await tick(); await bridge.pumpToSimplex(); await tick();
ok(store.state.owner?.contactId === 9, "owner paired via invitation");
ok(!fs.existsSync(paths.pairingLink), "pairing link removed");
ok(sent[0].text.startsWith("Paired"), "welcome sent");
const fwd = sent.find((s) => s.text?.includes("Hi there"));
ok(fwd && fwd.text.includes("*Anna Müller* · annamuller") && fwd.text.includes("🆕"), "forwarded with header: " + JSON.stringify(fwd?.text));
ok(store.state.toSimplex.length === 0, "queue drained");

// 4. second contact with attachment and quote
session.emit("message", { id: "m2", type: "private", from: BEN, author: { displayName: "(05cc...cccc)" }, text: "pic", attachments: [{ id: "f1", name: "cat.jpg", metadata: { contentType: "image/jpeg" }, _key: new Uint8Array([1]), _digest: new Uint8Array([2]) }], replyToMessage: { text: "earlier msg" }, timestamp: 2000 });
await tick(); await tick();
const benMsg = sent.find((s) => s.text?.includes("pic"));
ok(benMsg && benMsg.text.includes("quote to reply") && benMsg.text.includes("> earlier msg"), "Ben header + hint + quote: " + JSON.stringify(benMsg?.text));
const fileMsg = sent.find((s) => s.filePath);
ok(fileMsg && fs.existsSync(fileMsg.filePath), "attachment downloaded and sent as file");
const owner = (itemId: number, text: string, extra: any = {}) => fakeSimplex.onEvent({ type: "newChatItems", chatItems: [{ chatInfo: { type: "direct", contact: { contactId: 9 } }, chatItem: { chatDir: { type: "directRcv" }, content: { type: "rcvMsgContent", msgContent: { type: extra.type ?? "text", text } }, meta: { itemId }, ...extra.ci } }] });

// 5. plain reply goes to active (Anna, first contact)
owner(900, "hello anna"); await tick(); await tick();
ok(session.sent.at(-1)?.to === ANNA && session.sent.at(-1).text === "hello anna", "plain reply → active (Anna)");
ok(cmds.includes("react 900 ✅"), "✅ reaction after delivery");

// 6. quote Ben's forwarded message → goes to Ben with quote, Ben becomes active
owner(901, "hi ben", { ci: { quotedItem: { itemId: benMsg.itemId } } }); await tick(); await tick();
const last = session.sent.at(-1);
ok(last.to === BEN && last.replyToMessage?.timestamp === 2000, "quote reply → Ben with Session quote");
ok(store.state.active === BEN, "active switched to Ben");

// 7. commands
const before = sent.length;
owner(902, "/list"); await tick();
ok(sent.at(-1).text.includes("annamuller") && sent.at(-1).text.includes("▶"), "/list: " + JSON.stringify(sent.at(-1).text));
owner(903, "/to anna see you later"); await tick(); await tick();
ok(session.sent.at(-1).to === ANNA && session.sent.at(-1).text === "see you later", "/to anna <text>");
owner(904, "/name anna ann"); await tick();
ok(store.state.contacts[ANNA].alias === "ann", "/name renames");
owner(905, "//slash message"); await tick(); await tick();
ok(session.sent.at(-1).text === "/slash message", "// escapes slash");
owner(906, "/bogus"); await tick();
ok(sent.at(-1).text.startsWith("Unknown command"), "unknown command reply");

// 8. retry when Session is offline
session.failNext = 1;
owner(907, "retry me"); await tick(); await tick();
ok(store.state.toSession.length === 1 && store.state.toSession[0].tries === 1, "failed send kept in queue");
store.state.toSession[0].nextAt = 0; await bridge.pumpToSession(); await tick();
ok(store.state.toSession.length === 0 && session.sent.at(-1).text === "retry me", "retried and delivered");

// 9. owner sends a file
fs.writeFileSync(paths.simplexFiles + "/photo.jpg", "jpgdata");
owner(908, "look", { type: "image", ci: { file: { fileId: 77, fileName: "photo.jpg" } } }); await tick();
ok(cmds.includes("freceive 77"), "file receive requested");
fakeSimplex.onEvent({ type: "rcvFileComplete", chatItem: { chatItem: { file: { fileId: 77, fileSource: { filePath: "photo.jpg" } } } } });
await tick(); await tick();
const fm = session.sent.at(-1);
ok(fm.attachments?.[0]?.name === "photo.jpg" && fm.attachments[0].type === "image/jpeg" && fm.text === "look", "file sent to Session");
ok(!fs.existsSync(paths.simplexFiles + "/photo.jpg"), "local copy deleted after send");

// 10. non-owner message ignored; restart keeps state
const n = session.sent.length;
fakeSimplex.onEvent({ type: "newChatItems", chatItems: [{ chatInfo: { type: "direct", contact: { contactId: 2 } }, chatItem: { chatDir: { type: "directRcv" }, content: { type: "rcvMsgContent", msgContent: { type: "text", text: "/to x hack" } }, meta: { itemId: 1 } } }] });
await tick();
ok(session.sent.length === n, "messages from other SimpleX contacts ignored");
store.flush();
const saved = JSON.parse(fs.readFileSync(paths.state, "utf8"));
ok(saved.owner.contactId === 9 && Object.keys(saved.refs).length > 0, "state persisted");
ok((fs.statSync(paths.state).mode & 0o777) === 0o600, "state file is private (600)");


// 11. /status shows the network line
owner(950, "/status"); await tick();
ok(sent.at(-1).text.includes("Network: Tor ✅ (test)") && sent.at(-1).text.includes("Last successful Session check"), "/status answers with network info: " + JSON.stringify(sent.at(-1).text));

// 12. health alert: Session unreachable for a while → one warning, then "reachable again"
bridge.health = new Health({ alertAfterMs: 50, remindEveryMs: 60_000, sleepGapMs: 60_000 });
torUp = false; // e.g. no internet: Tor can't connect
const n0 = sent.length;
bridge.checkHealth();
await sleep(80);
bridge.checkHealth(); await tick();
const alert = sent.slice(n0).find((s) => s.text?.includes("No connection to Session"));
ok(alert && alert.text.includes("Tor connecting"), "health alert sent with the reason: " + JSON.stringify(alert?.text));
bridge.checkHealth(); await tick();
ok(sent.slice(n0).filter((s) => s.text?.includes("No connection to Session")).length === 1, "alert is not repeated");
torUp = true;
bridge.checkHealth(); await tick();
ok(sent.slice(n0).some((s) => s.text?.includes("reachable again")), "recovery message sent");

// 13. failing polls: retried quickly, and a fresh Tor circuit is requested
poller.failing = true;
const waitForPoll = async (after: number) => { for (let i = 0; i < 200 && poller.polls === after; i++) await sleep(25); };
await waitForPoll(poller.polls); // 1st failing poll (the loop may still be in its short "Tor not ready" wait)
const firstAt = Date.now();
await waitForPoll(poller.polls); // 2nd failing poll
const gap = Date.now() - firstAt;
await sleep(100);
ok(gap > 2000 && gap < 6000, "failed poll is retried after ~3 s, not minutes: " + gap + " ms");
ok(circuits >= 1, "fresh Tor circuit requested after repeated failures: " + circuits);
poller.failing = false;
bridge.stop();

done();

import fs from "node:fs";
import { Session, Poller, ready } from "@session.js/client";
import { ensureDirs, paths, config } from "./config.ts";
import { log, errMsg, shortId } from "./log.ts";
import { store, sessionStorage } from "./store.ts";
import { getSecret } from "./secrets.ts";
import { SimplexClient } from "./simplex.ts";
import { Bridge } from "./bridge.ts";
import { Tor } from "./tor.ts";
import { startTorHttpProxy, forceFetchThroughProxy } from "./tor-proxy.ts";

function acquireLock() {
  if (fs.existsSync(paths.lock)) {
    const pid = Number(fs.readFileSync(paths.lock, "utf8"));
    let alive = false;
    try {
      if (pid && pid !== process.pid) {
        process.kill(pid, 0);
        // Make sure the pid wasn't reused by an unrelated process after a crash.
        const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe" });
        alive = ps.stdout.toString().includes("main.ts");
      }
    } catch {}
    if (alive) {
      log.error(`Another bridge is already running (pid ${pid}). Exiting.`);
      process.exit(0);
    }
  }
  fs.writeFileSync(paths.lock, String(process.pid), { mode: 0o600 });
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(paths.lock, "utf8")) === process.pid) fs.rmSync(paths.lock);
  } catch {}
}

ensureDirs();
acquireLock();
store.load();

const mnemonic = getSecret("session-mnemonic");
const dbKey = getSecret("simplex-db-key");
if (!mnemonic || !dbKey) {
  log.error("Not set up yet. Run: bun run setup");
  releaseLock();
  process.exit(0); // exit 0 so launchd doesn't restart in a loop
}

// ---- Network: Tor only, unless explicitly turned off ----
let tor: Tor | undefined;
let simplex: SimplexClient | undefined;
let bridge: Bridge | undefined;

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Stopping (${signal})`);
  bridge?.stop();
  store.flush();
  await simplex?.stop();
  await tor?.stop();
  store.flush();
  releaseLock();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log.error("Unhandled rejection:", errMsg(e)));
process.on("uncaughtException", (e) => {
  log.error("Uncaught exception:", errMsg(e));
  store.flush();
});

let simplexSocks: string | undefined;
if (config.tor) {
  const t = new Tor();
  tor = t;
  // Kill switch for the Session side: every fetch() in this process goes through
  // this proxy, which only talks to Tor. Installed before anything touches the network.
  const proxy = await startTorHttpProxy(t.socks, { isolation: "session-bridge", isReady: () => t.ready });
  forceFetchThroughProxy(proxy.url);
  simplexSocks = `${t.socks.host}:${t.socks.port}`;
  t.start();
  log.info("Waiting for Tor to connect…");
  const progress = setInterval(() => log.info(t.status()), 30_000);
  await t.whenReady();
  clearInterval(progress);
} else {
  log.warn("Tor is turned off (BRIDGE_TOR=off): connecting directly, your IP is visible.");
}

await ready;
const session = new Session({ storage: sessionStorage });
session.setMnemonic(mnemonic, store.state.sessionDisplayName);
const poller = new Poller({ interval: null }); // the bridge drives polling itself
session.addPoller(poller);
log.info(`Bridge starting. Session ID ${shortId(session.getSessionID())}`);

simplex = new SimplexClient(dbKey, simplexSocks);
bridge = new Bridge(simplex, session, poller, {
  isReady: () => !tor || tor.ready,
  status: () => (tor ? tor.status() : "direct (Tor turned off)"),
});
bridge.start();

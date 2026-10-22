import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Project root (one level above src/). */
export const ROOT = path.resolve(import.meta.dir, "..");

const defaultDataDir =
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "session-simplex-bridge")
    : path.join(os.homedir(), ".local", "share", "session-simplex-bridge");

export const config = {
  /** All state lives here: bridge state, SimpleX database, temporary files. */
  dataDir: process.env.BRIDGE_DATA_DIR ?? defaultDataDir,
  /** Path to the simplex-chat CLI binary (install.sh downloads it into ./bin). */
  simplexBin: process.env.SIMPLEX_BIN ?? path.join(ROOT, "bin", "simplex-chat"),
  /** Local WebSocket port of the SimpleX CLI. Bound to localhost only. */
  simplexPort: Number(process.env.SIMPLEX_PORT ?? 5225),
  /** Display name of the bridge in your SimpleX contact list (only you see it). */
  simplexBotName: process.env.SIMPLEX_BOT_NAME ?? "Session",
  /** How often to poll Session for new messages (ms). */
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
  /** Keep retrying a failed delivery to Session for this long before giving up (ms). */
  sendGiveUpMs: Number(process.env.SEND_GIVE_UP_MS ?? 24 * 60 * 60 * 1000),
  /** Where secrets are kept: "keychain" (macOS default) or "file". */
  secretsBackend:
    process.env.BRIDGE_SECRETS ?? (process.platform === "darwin" ? "keychain" : "file"),
  /** Route all traffic through Tor (default). Set BRIDGE_TOR=off to connect directly. */
  tor: (process.env.BRIDGE_TOR ?? "on").toLowerCase() !== "off",
  /** Use an already running Tor (e.g. "127.0.0.1:9050") instead of starting the bundled one. */
  torExternalSocks: process.env.TOR_SOCKS || undefined,
  /** Bundled tor binary (install.sh puts the Tor Expert Bundle into ./bin/tor). */
  torBin: process.env.TOR_BIN ?? path.join(ROOT, "bin", "tor", "tor", "tor"),
  /** SOCKS port of the bundled Tor (localhost only). */
  torSocksPort: Number(process.env.TOR_SOCKS_PORT ?? 9250),
};

export const paths = {
  state: path.join(config.dataDir, "state.json"),
  secretsFile: path.join(config.dataDir, "secrets.json"),
  lock: path.join(config.dataDir, "bridge.lock"),
  pairingLink: path.join(config.dataDir, "pairing-link.txt"),
  simplexDb: path.join(config.dataDir, "simplex", "bridge"),
  simplexFiles: path.join(config.dataDir, "files"),
  simplexTmp: path.join(config.dataDir, "tmp"),
  incoming: path.join(config.dataDir, "files", "from-session"),
  torData: path.join(config.dataDir, "tor"),
};

export function ensureDirs() {
  for (const dir of [
    config.dataDir,
    path.dirname(paths.simplexDb),
    paths.simplexFiles,
    paths.simplexTmp,
    paths.incoming,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(config.dataDir, 0o700);
  } catch {}
}

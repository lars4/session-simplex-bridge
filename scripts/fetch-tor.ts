// Downloads the official Tor Expert Bundle (just the tor daemon, no browser)
// from torproject.org into bin/tor, and checks it against a pinned SHA-256.
//
//   bun run scripts/fetch-tor.ts <destination-dir>
//
// To update Tor: change VERSION and the hashes below to the values from
// https://dist.torproject.org/torbrowser/<VERSION>/sha256sums-signed-build.txt
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const VERSION = "15.0.25";
const SHA256: Record<string, string> = {
  "macos-x86_64": "e1ae4d4a734d28bb590839188511deb3cebc26fcbce9df66d01b2c452060fe95",
  "macos-aarch64": "a3febb6179152b0b4f56a0f5cc57bf5cc8ecef7db35e7c3e9d5a044c8158c26c",
  "linux-x86_64": "19cf18726eecb362e0f21d27afa9ea9efe5da928bfdfbb1ceb5fe54519e87f4a",
};

const dest = path.resolve(process.argv[2] ?? "bin/tor");

function fail(msg: string): never {
  console.error(`    ${msg}`);
  process.exit(1);
}

const os_ = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : "";
const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : "";
const platform = `${os_}-${arch}`;
const expected = SHA256[platform];
if (!expected) fail(`No Tor bundle configured for ${process.platform}/${process.arch}.`);

const file = `tor-expert-bundle-${platform}-${VERSION}.tar.gz`;
const url = `https://dist.torproject.org/torbrowser/${VERSION}/${file}`;
console.log(`    Downloading Tor (${file})`);
const res = await fetch(url);
if (!res.ok) fail(`Download failed (HTTP ${res.status}): ${url}`);
const data = new Uint8Array(await res.arrayBuffer());
const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
if (hash !== expected) fail("Checksum mismatch. The download was not used.");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tor-"));
try {
  const archive = path.join(tmp, file);
  fs.writeFileSync(archive, data);
  const out = path.join(tmp, "x");
  fs.mkdirSync(out);
  const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", out]);
  if (tar.exitCode !== 0) fail("Could not unpack the download.");
  if (!fs.existsSync(path.join(out, "tor", "tor"))) fail("Unexpected bundle layout (tor/tor missing).");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(out, dest);
  fs.chmodSync(path.join(dest, "tor", "tor"), 0o755);
  fs.writeFileSync(path.join(dest, "VERSION"), VERSION + "\n");
  console.log(`    Saved to ${dest}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

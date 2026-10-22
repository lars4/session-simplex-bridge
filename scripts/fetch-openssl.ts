// Puts OpenSSL's libcrypto.3.dylib into bin/lib so simplex-chat runs without
// Homebrew.
//
// Apple Silicon: uses Homebrew's prebuilt "openssl@3" package (the same file
// `brew install openssl@3` installs), checked against Homebrew's published SHA-256.
// Intel Macs: Homebrew no longer publishes Intel builds, so the library is built
// from OpenSSL's official source release (pinned version, checked SHA-256).
// Building needs Apple's Command Line Tools and takes a few minutes.
//
//   bun run scripts/fetch-openssl.ts <destination-dir>
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dest = path.resolve(process.argv[2] ?? "bin/lib");
const LIB = "libcrypto.3.dylib";

// Official OpenSSL 3.5 LTS source release.
const SRC_VERSION = "3.5.9";
const SRC_SHA256 = "603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a";
const SRC_URL = `https://github.com/openssl/openssl/releases/download/openssl-${SRC_VERSION}/openssl-${SRC_VERSION}.tar.gz`;

// Homebrew bottle tags → macOS major version
const TAGS: Record<string, number> = {
  golden_gate: 27,
  tahoe: 26,
  sequoia: 15,
  sonoma: 14,
  ventura: 13,
  monterey: 12,
  big_sur: 11,
};

class Fail extends Error {}

function sha256(data: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function run(cmd: string[], cwd?: string) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    const out = (r.stderr.toString() + r.stdout.toString()).trim().split("\n").slice(-8).join("\n");
    throw new Fail(`${cmd[0]} failed:\n${out}`);
  }
  return r.stdout.toString();
}

function install(file: string) {
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(file, path.join(dest, LIB));
  fs.chmodSync(path.join(dest, LIB), 0o644);
  console.log(`    Saved ${path.join(dest, LIB)}`);
}

async function download(url: string, headers?: Record<string, string>) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Fail(`Download failed (HTTP ${res.status}): ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Apple Silicon: Homebrew's prebuilt package. Returns false if there is none for this Mac. */
async function fromBottle(tmp: string): Promise<boolean> {
  const arm = process.arch === "arm64";
  const osMajor = Number(run(["sw_vers", "-productVersion"]).trim().split(".")[0]);
  const res = await fetch("https://formulae.brew.sh/api/formula/openssl@3.json");
  if (!res.ok) return false;
  const formula = (await res.json()) as {
    versions: { stable: string };
    bottle: { stable: { files: Record<string, { url: string; sha256: string }> } };
  };
  let best: { tag: string; ver: number } | undefined;
  for (const tag of Object.keys(formula.bottle.stable.files)) {
    const isArm = tag.startsWith("arm64_");
    const ver = TAGS[tag.replace(/^(arm64|x86_64)_/, "")];
    if (ver === undefined || isArm !== arm || ver > osMajor) continue;
    if (!best || ver > best.ver) best = { tag, ver };
  }
  if (!best) return false;
  const { url, sha256: expected } = formula.bottle.stable.files[best.tag];
  console.log(`    Downloading OpenSSL ${formula.versions.stable} (${best.tag})`);
  // ghcr.io serves Homebrew's public packages with this anonymous token.
  const data = await download(url, { Authorization: "Bearer QQ==" });
  if (sha256(data) !== expected) throw new Fail("Checksum mismatch. The download was not used.");
  const archive = path.join(tmp, "bottle.tar.gz");
  fs.writeFileSync(archive, data);
  run(["tar", "-xzf", archive, "-C", tmp]);
  const found = run(["find", tmp, "-name", LIB, "-type", "f"]).trim().split("\n")[0];
  if (!found) throw new Fail(`${LIB} not found in the package.`);
  install(found);
  return true;
}

/** Intel (or no package available): build libcrypto from the official source. */
async function fromSource(tmp: string) {
  const clt = Bun.spawnSync(["xcode-select", "-p"]);
  if (clt.exitCode !== 0) {
    throw new Fail(
      "Building OpenSSL needs Apple's Command Line Tools. Install them with:\n" +
        "      xcode-select --install\n    then run ./install.sh again.",
    );
  }
  console.log(`    Downloading OpenSSL ${SRC_VERSION} source from openssl.org's GitHub`);
  const data = await download(SRC_URL);
  if (sha256(data) !== SRC_SHA256) throw new Fail("Checksum mismatch. The download was not used.");
  const archive = path.join(tmp, "openssl.tar.gz");
  fs.writeFileSync(archive, data);
  run(["tar", "-xzf", archive, "-C", tmp]);
  const src = path.join(tmp, `openssl-${SRC_VERSION}`);

  const target = process.arch === "arm64" ? "darwin64-arm64-cc" : "darwin64-x86_64-cc";
  const cpus = String(Math.max(1, os.cpus().length));
  console.log("    Building OpenSSL (takes a few minutes)…");
  // Same feature set as Homebrew's openssl@3, minus the command-line tool, tests and docs.
  run(
    [
      "perl", "./Configure", target, "shared",
      "no-ssl3", "no-ssl3-method", "no-zlib",
      "no-tests", "no-docs", "no-apps",
      `--prefix=${path.join(dest, "openssl")}`,
      `--openssldir=${path.join(dest, "openssl", "ssl")}`,
    ],
    src,
  );
  run(["make", `-j${cpus}`, "build_libs"], src);
  const built = path.join(src, LIB);
  if (!fs.existsSync(built)) throw new Fail(`Build finished but ${LIB} is missing.`);
  install(built);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openssl-"));
try {
  if (!(await fromBottle(tmp).catch(() => false))) await fromSource(tmp);
} catch (e) {
  console.error(`    ${e instanceof Fail ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

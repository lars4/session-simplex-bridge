import fs from "node:fs";
import { config, paths } from "./config.ts";

// Two secrets: the Session recovery phrase (your Session identity) and the
// SimpleX database passphrase. On macOS they live in the login Keychain;
// elsewhere in a 0600 file inside the data directory.

const SERVICE = "session-simplex-bridge";
export type SecretName = "session-mnemonic" | "simplex-db-key";

function keychainGet(name: SecretName): string | null {
  const r = Bun.spawnSync(["security", "find-generic-password", "-s", SERVICE, "-a", name, "-w"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) return null;
  const v = r.stdout.toString().replace(/\n$/, "");
  return v || null;
}

function keychainSet(name: SecretName, value: string) {
  // -U updates an existing item. The value is passed as an argument, so it is briefly
  // visible to other local processes of the same user via `ps`. Acceptable for a
  // one-time setup step on a single-user Mac.
  const r = Bun.spawnSync(
    ["security", "add-generic-password", "-U", "-s", SERVICE, "-a", name, "-w", value],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`Keychain write failed: ${r.stderr.toString().trim()}`);
}

function readFileSecrets(): Record<string, string> {
  if (!fs.existsSync(paths.secretsFile)) return {};
  return JSON.parse(fs.readFileSync(paths.secretsFile, "utf8"));
}

export function getSecret(name: SecretName): string | null {
  if (config.secretsBackend === "keychain") return keychainGet(name);
  return readFileSecrets()[name] ?? null;
}

export function setSecret(name: SecretName, value: string) {
  if (config.secretsBackend === "keychain") return keychainSet(name, value);
  const all = readFileSecrets();
  all[name] = value;
  fs.writeFileSync(paths.secretsFile, JSON.stringify(all), { mode: 0o600 });
  fs.chmodSync(paths.secretsFile, 0o600);
}

export function randomPassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

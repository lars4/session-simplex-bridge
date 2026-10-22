// Interactive first-time setup: creates or imports the Session identity and the
// SimpleX database passphrase. Safe to run again; it never overwrites without asking.
import { Session, ready } from "@session.js/client";
import { generateSeedHex } from "@session.js/keypair";
import { encode, decode } from "@session.js/mnemonic";
import { ensureDirs, config, paths } from "./config.ts";
import { store } from "./store.ts";
import { getSecret, setSecret, randomPassphrase } from "./secrets.ts";

function ask(q: string): string {
  return (prompt(q) ?? "").trim();
}

function sessionIdFor(mnemonic: string): string {
  const s = new Session();
  s.setMnemonic(mnemonic);
  return s.getSessionID();
}

ensureDirs();
store.load();
await ready;

console.log("\nSession → SimpleX bridge setup");
console.log(`Data folder: ${config.dataDir}`);
console.log(`Secrets stored in: ${config.secretsBackend === "keychain" ? "macOS Keychain" : paths.secretsFile}\n`);

let mnemonic = getSecret("session-mnemonic");
if (mnemonic) {
  console.log(`A Session identity already exists: ${sessionIdFor(mnemonic)}`);
  if (ask("Replace it? This changes your Session ID. [y/N]").toLowerCase() === "y") mnemonic = null;
}

if (!mnemonic) {
  console.log("\nWhich Session ID should people write to?");
  console.log("  1) Create a new Session ID just for this (recommended)");
  console.log("  2) Use an existing Session account (enter its recovery phrase)");
  const choice = ask("Choose 1 or 2 [1]:") || "1";
  if (choice === "2") {
    console.log(
      "\nNote: if that account is still logged in on another device, messages show up there too.",
    );
    const phrase = ask("Recovery phrase (13 words):").toLowerCase().replace(/\s+/g, " ");
    try {
      decode(phrase);
    } catch {
      console.error("That recovery phrase is not valid. Nothing was changed.");
      process.exit(1);
    }
    mnemonic = phrase;
  } else {
    mnemonic = encode(generateSeedHex());
  }
  setSecret("session-mnemonic", mnemonic);
  // Seen-message state belongs to the previous identity.
  store.state.sessionjs = {};
  console.log("\nSaved.");
}

const name = ask(
  `Display name Session contacts see (optional)${store.state.sessionDisplayName ? ` [${store.state.sessionDisplayName}]` : ""}:`,
);
if (name) store.state.sessionDisplayName = name.slice(0, 64);
store.flush();

if (!getSecret("simplex-db-key")) setSecret("simplex-db-key", randomPassphrase());

console.log(`\nYour bridge's Session ID (share this one):\n\n  ${sessionIdFor(mnemonic)}\n`);
if (config.secretsBackend === "keychain") {
  console.log("Back up the recovery phrase somewhere safe. To show it:");
  console.log("  security find-generic-password -s session-simplex-bridge -a session-mnemonic -w\n");
}
process.exit(0);

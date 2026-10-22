// Shows the one-time SimpleX pairing link as a QR code.
//   bun run pair          show the current pairing link
//   bun run pair --reset  forget the paired SimpleX profile and create a new link
import fs from "node:fs";
import qrcode from "qrcode-terminal";
import { ensureDirs, paths } from "./config.ts";
import { store } from "./store.ts";

const LABEL = "local.session-simplex-bridge";

function launchctl(...args: string[]) {
  return Bun.spawnSync(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

ensureDirs();

if (process.argv.includes("--reset")) {
  const uid = process.getuid?.() ?? 0;
  const managed = process.platform === "darwin" && launchctl("print", `gui/${uid}/${LABEL}`);
  if (managed) launchctl("bootout", `gui/${uid}/${LABEL}`);
  else if (fs.existsSync(paths.lock)) {
    console.error("Stop the running bridge first, then run this again.");
    process.exit(1);
  }
  store.load();
  store.state.owner = undefined;
  store.state.invitation = undefined;
  store.flush();
  fs.rmSync(paths.pairingLink, { force: true });
  console.log("Pairing reset. In SimpleX you can delete the old bridge chat.");
  if (managed) {
    const plist = `${process.env.HOME}/Library/LaunchAgents/${LABEL}.plist`;
    launchctl("bootstrap", `gui/${uid}`, plist);
    console.log("Bridge restarted. Waiting for the new link…");
  } else {
    console.log("Start the bridge (bun run start), then run: bun run pair");
    process.exit(0);
  }
}

for (let i = 0; i < 60 && !fs.existsSync(paths.pairingLink); i++) {
  if (i === 0) {
    store.load();
    if (store.state.owner) {
      console.log("Already paired with your SimpleX profile. To pair again: bun run pair --reset");
      process.exit(0);
    }
  }
  await Bun.sleep(1000);
}
if (!fs.existsSync(paths.pairingLink)) {
  console.error("No pairing link yet. Is the bridge running? Check the log:");
  console.error("  tail -f ~/Library/Logs/session-simplex-bridge.log");
  process.exit(1);
}

const link = fs.readFileSync(paths.pairingLink, "utf8").trim();
console.log("\nIn SimpleX, switch to the profile that should receive the messages (e.g. your hidden one),");
console.log("then tap + → Scan / paste link, and scan this code:\n");
qrcode.generate(link, { small: true });
console.log(`\nOr paste this link:\n${link}\n`);
console.log("The link works once. After you connect, the bridge greets you in that chat.");

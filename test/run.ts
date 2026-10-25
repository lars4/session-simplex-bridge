// Runs every test file in its own process with its own empty data folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = import.meta.dir;
// NO_PROXY would make Bun's fetch skip the proxy for matching hosts (see proxyBypassProblem).
const env = { ...process.env, BRIDGE_SECRETS: "file", BRIDGE_TOR: "off" } as Record<string, string | undefined>;
delete env.NO_PROXY;
delete env.no_proxy;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort();
let failed = 0;
for (const f of files) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "ssb-test-"));
  console.log(`\n=== ${f}`);
  const p = Bun.spawnSync([process.execPath, path.join(dir, f)], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...env, BRIDGE_DATA_DIR: data } as Record<string, string>,
  });
  if (p.exitCode !== 0) failed++;
  fs.rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} test file(s) FAILED` : `\nAll ${files.length} test files passed`);
process.exit(failed ? 1 : 0);

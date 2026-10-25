// Checks that the running bridge only talks to Tor.
//   bun run verify              check the running bridge, then ask check.torproject.org
//   bun run verify --offline    skip the check.torproject.org request
//
// It looks at the real network connections of the bridge, the SimpleX CLI and Tor
// (using lsof): the bridge and the SimpleX CLI may only connect to this computer
// (the local Tor port); only Tor itself may connect to the outside.
import fs from "node:fs";
import { config, paths } from "./config.ts";
import { Tor } from "./tor.ts";
import { startTorHttpProxy } from "./tor-proxy.ts";

export type Conn = {
  command: string;
  pid: number;
  proto: "TCP" | "UDP";
  local: string;
  remote?: string;
  state?: string;
};

export function splitEndpoint(ep: string): { host: string; port: string } {
  const m = /^\[(.*)\]:(\d+|\*)$/.exec(ep) ?? /^(.*):(\d+|\*)$/.exec(ep);
  return m ? { host: m[1], port: m[2] } : { host: ep, port: "" };
}

export function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Parses the output of `lsof -nP -i`. */
export function parseLsof(text: string): Conn[] {
  const conns: Conn[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim().split(/\s+/);
    const node = t.findIndex((x) => x === "TCP" || x === "UDP");
    if (node < 2 || !/^\d+$/.test(t[1])) continue;
    const name = t.slice(node + 1).join(" ");
    const state = /\((\w+)\)\s*$/.exec(name)?.[1];
    const [local, remote] = name.replace(/\s*\(\w+\)\s*$/, "").split("->");
    conns.push({ command: t[0], pid: Number(t[1]), proto: t[node] as "TCP" | "UDP", local, remote, state });
  }
  return conns;
}

export type Verdict = { fails: string[]; warns: string[]; infos: string[] };

/** The rules. `role` says what the process is allowed to do. */
export function judge(role: "bridge" | "simplex" | "tor", conns: Conn[]): Verdict {
  const v: Verdict = { fails: [], warns: [], infos: [] };
  let local = 0;
  let outside = 0;
  const seen = new Set<string>();
  for (const c of conns) {
    const lh = splitEndpoint(c.local).host;
    const rh = c.remote ? splitEndpoint(c.remote).host : undefined;
    if (c.state === "LISTEN") {
      if (!isLocalHost(lh)) v.fails.push(`listens on ${c.local}, reachable from other computers (should be 127.0.0.1 only)`);
      continue;
    }
    if (c.proto === "UDP" && !c.remote) {
      const key = `udp ${c.local}`;
      if (!seen.has(key) && role !== "tor") v.warns.push(`has a UDP socket (${c.local}); can't tell where it sends`);
      seen.add(key);
      continue;
    }
    if (rh && isLocalHost(rh)) {
      local++;
    } else if (rh) {
      outside++;
      if (role !== "tor") v.fails.push(`connects directly to ${c.remote} (not through Tor)`);
    }
  }
  if (role === "tor") v.infos.push(`${outside} connection(s) to the Tor network`);
  else v.infos.push(`${local} connection(s), all to this computer`);
  return v;
}

// ---------------------------------------------------------------- running it

type Proc = { pid: number; ppid: number; command: string };

function listProcesses(): Proc[] {
  const out = Bun.spawnSync(["ps", "-axww", "-o", "pid=,ppid=,command="], { stdout: "pipe" }).stdout.toString();
  return out
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}

function descendants(all: Proc[], root: number): Proc[] {
  const found: Proc[] = [];
  const queue = [root];
  while (queue.length) {
    const p = queue.pop()!;
    for (const c of all.filter((x) => x.ppid === p)) {
      found.push(c);
      queue.push(c.pid);
    }
  }
  return found;
}

let failed = false;
const ok = (m: string) => console.log(`  ✅ ${m}`);
const warn = (m: string) => console.log(`  ⚠️  ${m}`);
const fail = (m: string) => {
  failed = true;
  console.log(`  ❌ ${m}`);
};

function report(name: string, v: Verdict) {
  v.fails.forEach((m) => fail(`${name} ${m}`));
  v.warns.forEach((m) => warn(`${name} ${m}`));
  if (!v.fails.length) ok(`${name}: ${v.infos.join(", ")}`);
}

async function main() {
  console.log("Session → SimpleX bridge: Tor check\n");
  if (!config.tor) fail("Tor is turned off in this shell (BRIDGE_TOR=off).");

  // 1. Is the bridge running?
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(paths.lock, "utf8"));
  } catch {}
  const all = listProcesses();
  const bridgeProc = all.find((p) => p.pid === pid && p.command.includes("main.ts"));
  if (!bridgeProc) {
    fail("The bridge is not running. Start it (launchctl kickstart …) and run this again.");
    return;
  }
  ok(`Bridge is running (pid ${bridgeProc.pid})`);
  const kids = descendants(all, bridgeProc.pid);
  const simplex = kids.find((p) => p.command.includes("simplex-chat"));
  const tor = kids.find((p) => /\/tor\s/.test(p.command + " ") && p.command.includes("--SocksPort"));

  // 2. How were the processes started?
  if (!simplex) fail("The SimpleX CLI is not running.");
  else if (
    /--socks-proxy\s+127\.0\.0\.1:\d+/.test(simplex.command) &&
    /--socks-mode\s+always/.test(simplex.command)
  ) {
    ok("SimpleX CLI is set to use only the local Tor port (--socks-mode always)");
  } else {
    fail("SimpleX CLI is NOT started in Tor-only mode.");
  }
  if (tor) {
    if (/--SocksPort\s+127\.0\.0\.1:\d+/.test(tor.command)) ok("Tor's SOCKS port is bound to 127.0.0.1 only");
    else fail("Tor's SOCKS port is not bound to 127.0.0.1.");
  } else if (config.torExternalSocks) {
    ok(`Using your own Tor at ${config.torExternalSocks}`);
  } else {
    fail("The bundled Tor is not running.");
  }

  // 3. What are they connected to right now?
  const pids = [bridgeProc.pid, simplex?.pid, tor?.pid].filter((x): x is number => !!x);
  let lsofText: string | undefined;
  try {
    const r = Bun.spawnSync(["lsof", "-nP", "-a", "-i", "-p", pids.join(",")], { stdout: "pipe", stderr: "pipe" });
    lsofText = r.stdout.toString(); // empty when none of them has a network connection
  } catch {
    warn("lsof isn't installed, so open connections can't be listed.");
  }
  if (lsofText !== undefined) {
    const conns = parseLsof(lsofText);
    const of = (p?: number) => conns.filter((c) => c.pid === p);
    report("Bridge", judge("bridge", of(bridgeProc.pid)));
    if (simplex) report("SimpleX CLI", judge("simplex", of(simplex.pid)));
    if (tor) report("Tor", judge("tor", of(tor.pid)));
  }

  // 4. Does traffic through the bridge's Tor really exit through Tor?
  if (process.argv.includes("--offline")) return;
  console.log("\nAsking check.torproject.org through the bridge's Tor…");
  const t = new Tor();
  const proxy = await startTorHttpProxy(t.socks, { isolation: "verify", isReady: () => true });
  try {
    const res = await fetch("https://check.torproject.org/api/ip", {
      proxy: proxy.url,
      signal: AbortSignal.timeout(90_000),
    } as RequestInit);
    const body = (await res.json()) as { IsTor?: boolean; IP?: string };
    if (body.IsTor) ok(`check.torproject.org sees a Tor exit (${body.IP}), not your IP`);
    else fail(`check.torproject.org says this is NOT Tor (${body.IP})`);
  } catch (e) {
    warn(`Couldn't reach check.torproject.org through Tor: ${e instanceof Error ? e.message : e}`);
  } finally {
    proxy.close();
  }
}

if (import.meta.main) {
  await main();
  console.log(
    failed
      ? "\nResult: PROBLEM FOUND. Traffic may not be going through Tor only."
      : "\nResult: OK. The bridge only talks to this computer, and Tor does the rest.",
  );
  console.log(
    "Note: this is a snapshot of the connections open right now. For a continuous check,\n" +
      "use a firewall that logs outgoing connections (e.g. LuLu or Little Snitch).",
  );
  process.exit(failed ? 1 : 0);
}

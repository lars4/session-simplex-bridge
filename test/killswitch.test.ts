// The Tor kill switch: every fetch() goes through the local proxy into Tor's SOCKS port,
// hostnames are handed to Tor unresolved, and if Tor is unreachable nothing goes out directly.
import net from "node:net";
import http from "node:http";
import { startTorHttpProxy, forceFetchThroughProxy, proxyBypassProblem } from "../src/tor-proxy.ts";
import { ok, sleep, done } from "./util.ts";

// The bridge refuses to run with NO_PROXY set; the test environment must not have it either
// (run through `bun run test`, which removes it).
ok(!proxyBypassProblem(), "test environment has no NO_PROXY (unset it, or use `bun run test`)");
ok(proxyBypassProblem({ NO_PROXY: "127.0.0.1" })?.includes("refuses to start") && proxyBypassProblem({ no_proxy: "*" }) !== undefined && proxyBypassProblem({}) === undefined, "bridge refuses to start when NO_PROXY is set");

// A "destination" web server on localhost. If a request ever reaches it directly,
// the kill switch has a hole.
let destHits = 0;
const dest = http.createServer((_req, res) => {
  destHits++;
  res.end("hello from destination");
});
await new Promise<void>((r) => dest.listen(0, "127.0.0.1", r));
const destPort = (dest.address() as net.AddressInfo).port;

// A minimal fake Tor: SOCKS5 with username/password, records what was asked for,
// and connects every request to the local destination server.
const requests: { host: string; port: number; user: string }[] = [];
const socks = net.createServer((c) => {
  let stage = 0;
  let user = "";
  let buf = Buffer.alloc(0);
  c.on("error", () => {});
  c.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    if (stage === 0 && buf.length >= 3) {
      c.write(Buffer.from([5, 2]));
      buf = Buffer.alloc(0);
      stage = 1;
    } else if (stage === 1 && buf.length >= 2 && buf.length >= 2 + buf[1] + 1 + buf[2 + buf[1]]) {
      user = buf.subarray(2, 2 + buf[1]).toString();
      c.write(Buffer.from([1, 0]));
      buf = Buffer.alloc(0);
      stage = 2;
    } else if (stage === 2 && buf.length >= 5 && buf.length >= 5 + buf[4] + 2) {
      const host = buf.subarray(5, 5 + buf[4]).toString();
      const port = buf.readUInt16BE(5 + buf[4]);
      requests.push({ host, port, user });
      stage = 3;
      c.removeAllListeners("data");
      const up = net.connect(destPort, "127.0.0.1", () => {
        c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        c.pipe(up);
        up.pipe(c);
      });
      up.on("error", () => c.destroy());
    }
  });
});
await new Promise<void>((r) => socks.listen(0, "127.0.0.1", r));
const socksPort = (socks.address() as net.AddressInfo).port;
const realFetch = globalThis.fetch;

// 1. Normal operation: through the proxy, hostname unresolved, isolated circuits.
{
  const proxy = await startTorHttpProxy({ host: "127.0.0.1", port: socksPort }, { isolation: "test", isReady: () => true });
  forceFetchThroughProxy(proxy.url);
  const r1 = await fetch("http://some-site.example/page");
  ok((await r1.text()) === "hello from destination", "request reaches the destination through the SOCKS port");
  ok(requests[0]?.host === "some-site.example" && requests[0].port === 80, "hostname is handed to Tor unresolved (no local DNS): " + JSON.stringify(requests[0]));
  proxy.newCircuit();
  await fetch("http://some-site.example/page");
  ok(requests[1]?.user !== requests[0]?.user, `newCircuit() changes the Tor isolation: ${requests[0]?.user} → ${requests[1]?.user}`);
  // A library asking for a different proxy (or none) must still end up in Tor.
  const before = requests.length;
  await fetch("http://other.example/", { proxy: "http://127.0.0.1:1" } as RequestInit);
  ok(requests.length === before + 1, "a fetch that asks for another proxy is still forced through Tor");
  proxy.close();
  globalThis.fetch = realFetch;
}

// 2. Seed-node requests (plain http in Session.js) are upgraded to https on port 4443.
{
  const proxy = await startTorHttpProxy({ host: "127.0.0.1", port: socksPort }, { isolation: "seed", isReady: () => true });
  forceFetchThroughProxy(proxy.url);
  const before = requests.length;
  await fetch("http://seed1.getsession.org/json_rpc", { method: "POST", body: "{}" }).catch(() => {});
  const seen = requests.slice(before);
  ok(seen.length >= 1 && seen.every((r) => r.host === "seed1.getsession.org" && r.port === 4443), "seed request is upgraded to https:4443: " + JSON.stringify(seen));
  proxy.close();
  globalThis.fetch = realFetch;
}

// 3. Fail closed: Tor's SOCKS port is dead → the request fails, the destination is never contacted.
{
  const dead = net.createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  const deadPort = (dead.address() as net.AddressInfo).port;
  await new Promise<void>((r) => dead.close(() => r()));
  const proxy = await startTorHttpProxy({ host: "127.0.0.1", port: deadPort }, { isolation: "dead", isReady: () => true });
  forceFetchThroughProxy(proxy.url);
  destHits = 0;
  let outcome = "";
  try {
    const r = await fetch(`http://127.0.0.1:${destPort}/direct`);
    outcome = `status ${r.status}`;
  } catch (e) {
    outcome = "error";
  }
  await sleep(100);
  ok(destHits === 0, `Tor down → no direct connection to the destination (fetch ended with: ${outcome})`);
  ok(outcome === "error" || outcome.startsWith("status 5"), "Tor down → the request fails: " + outcome);
  proxy.close();
  globalThis.fetch = realFetch;
}

// 4. Tor not ready yet → the proxy refuses (503) and nothing is sent.
{
  const proxy = await startTorHttpProxy({ host: "127.0.0.1", port: socksPort }, { isolation: "wait", isReady: () => false });
  forceFetchThroughProxy(proxy.url);
  destHits = 0;
  const before = requests.length;
  let outcome = "";
  try {
    outcome = "status " + (await fetch("http://some-site.example/")).status;
  } catch {
    outcome = "error";
  }
  ok(requests.length === before && destHits === 0, "Tor not ready → nothing is sent (" + outcome + ")");
  proxy.close();
  globalThis.fetch = realFetch;
}

socks.close();
dest.close();
done();

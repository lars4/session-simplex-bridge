import { parseLsof, judge, isLocalHost, splitEndpoint } from "../src/verify.ts";
import { ok, done } from "./util.ts";

const header = "COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\n";
const line = (cmd: string, pid: number, node: string, name: string) =>
  `${cmd.padEnd(10)} ${pid} admin   21u  IPv4 0x1234abcd      0t0  ${node} ${name}\n`;

ok(isLocalHost("127.0.0.1") && isLocalHost("::1") && !isLocalHost("*") && !isLocalHost("192.168.1.5") && !isLocalHost("127.0.0.1.evil.com"), "local address check");
ok(splitEndpoint("[::1]:5225").host === "::1" && splitEndpoint("*:5225").host === "*" && splitEndpoint("1.2.3.4:443").port === "443", "endpoint parsing");

// A healthy bridge: only talks to the local Tor port, listens on localhost.
const good =
  header +
  line("bun", 100, "TCP", "127.0.0.1:50000->127.0.0.1:9250 (ESTABLISHED)") +
  line("bun", 100, "TCP", "127.0.0.1:50001->127.0.0.1:5225 (ESTABLISHED)") +
  line("simplex-c", 200, "TCP", "127.0.0.1:5225 (LISTEN)") +
  line("simplex-c", 200, "TCP", "127.0.0.1:50002->127.0.0.1:9250 (ESTABLISHED)") +
  line("tor", 300, "TCP", "127.0.0.1:9250 (LISTEN)") +
  line("tor", 300, "TCP", "192.168.1.5:50111->185.220.101.4:9001 (ESTABLISHED)") +
  line("tor", 300, "TCP", "192.168.1.5:50112->51.15.2.3:443 (ESTABLISHED)");
const conns = parseLsof(good);
ok(conns.length === 7, "parses every connection line: " + conns.length);
const of = (pid: number) => conns.filter((c) => c.pid === pid);
ok(judge("bridge", of(100)).fails.length === 0, "bridge with only local connections passes");
ok(judge("simplex", of(200)).fails.length === 0, "SimpleX CLI listening on localhost passes");
const torV = judge("tor", of(300));
ok(torV.fails.length === 0 && torV.infos[0].startsWith("2 connection"), "Tor may connect outside: " + torV.infos[0]);

// A leak: the bridge connects to the internet directly.
const leak = parseLsof(header + line("bun", 100, "TCP", "192.168.1.5:50111->37.27.212.116:22101 (ESTABLISHED)"));
const leakV = judge("bridge", leak);
ok(leakV.fails.length === 1 && leakV.fails[0].includes("37.27.212.116"), "direct connection is a failure: " + leakV.fails[0]);

// The SimpleX API open to the network is a failure too.
const open = parseLsof(header + line("simplex-c", 200, "TCP", "*:5225 (LISTEN)"));
ok(judge("simplex", open).fails.length === 1, "listening on all interfaces is a failure");

// Tor's own SOCKS port must be local too.
ok(judge("tor", parseLsof(header + line("tor", 300, "TCP", "*:9250 (LISTEN)"))).fails.length === 1, "SOCKS port on all interfaces is a failure");

// UDP is only a warning (lsof can't show where an unconnected socket sends).
const udp = judge("bridge", parseLsof(header + line("bun", 100, "UDP", "*:5353")));
ok(udp.fails.length === 0 && udp.warns.length === 1, "UDP socket warns");
done();

import net from "node:net";
import { log, errMsg } from "./log.ts";
import { SEED_CERTS } from "./seed-certs.ts";

// A tiny HTTP proxy on 127.0.0.1 that sends every request into Tor's SOCKS5 port.
// Bun's fetch can only use HTTP proxies, and Tor only offers SOCKS for this, so
// this sits in between. Destination hostnames are handed to Tor unresolved
// (SOCKS5 "domain" addresses), so no DNS lookups happen on this machine.
// If Tor is unreachable, requests fail. There is no direct fallback.

const HEAD_LIMIT = 64 * 1024;
const CONNECT_TIMEOUT_MS = 90_000;

export type SocksTarget = { host: string; port: number };

/** Opens a TCP stream to host:port through a SOCKS5 proxy (Tor). */
export function socksConnect(
  socks: SocksTarget,
  host: string,
  port: number,
  isolation: string,
): Promise<{ socket: net.Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(socks.port, socks.host);
    let buf = Buffer.alloc(0);
    let stage: "method" | "auth" | "reply" = "method";
    const timer = setTimeout(() => fail(new Error("Tor connection timed out")), CONNECT_TIMEOUT_MS);
    const fail = (e: Error) => {
      clearTimeout(timer);
      s.destroy();
      reject(e);
    };
    s.once("error", (e) => fail(new Error(`Tor SOCKS port unreachable (${e.message})`)));
    s.once("close", () => fail(new Error("Tor closed the connection")));
    s.on("connect", () => {
      // Offer username/password auth only: Tor uses the credentials for circuit isolation.
      s.write(Buffer.from([0x05, 0x01, 0x02]));
    });
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (stage === "method") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x02) return fail(new Error("Tor SOCKS refused authentication method"));
        buf = buf.subarray(2);
        const u = Buffer.from(isolation.slice(0, 255));
        const p = Buffer.from("x");
        s.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        stage = "auth";
      }
      if (stage === "auth") {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) return fail(new Error("Tor SOCKS authentication failed"));
        buf = buf.subarray(2);
        s.write(connectRequest(host, port));
        stage = "reply";
      }
      if (stage === "reply") {
        if (buf.length < 5) return;
        const rep = buf[1];
        const atyp = buf[3];
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? 1 + buf[4] : -1;
        if (addrLen < 0) return fail(new Error("Bad SOCKS reply"));
        const total = 4 + addrLen + 2;
        if (buf.length < total) return;
        if (rep !== 0x00) return fail(new Error(`Tor could not reach ${host}:${port} (${socksError(rep)})`));
        clearTimeout(timer);
        s.removeListener("data", onData);
        s.removeAllListeners("error");
        s.removeAllListeners("close");
        resolve({ socket: s, rest: buf.subarray(total) });
      }
    };
    s.on("data", onData);
  });
}

function connectRequest(host: string, port: number) {
  const portBuf = Buffer.from([port >> 8, port & 0xff]);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, ...v4.slice(1).map(Number)]), portBuf]);
  }
  const name = Buffer.from(host.replace(/^\[|\]$/g, ""));
  if (name.length > 255) throw new Error("Hostname too long");
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, portBuf]);
}

function socksError(code: number) {
  return (
    {
      1: "general failure",
      2: "not allowed",
      3: "network unreachable",
      4: "host unreachable",
      5: "connection refused",
      6: "TTL expired",
      7: "command not supported",
      8: "address type not supported",
    }[code] ?? `error ${code}`
  );
}

function splitHostPort(s: string, defaultPort: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
  if (!m) throw new Error("Bad host");
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!(port > 0 && port < 65536)) throw new Error("Bad port");
  return { host: m[1], port };
}

/** Starts the proxy on a random localhost port. Returns its http:// URL. */
export function startTorHttpProxy(
  socks: SocksTarget,
  opts: { isolation: string; isReady: () => boolean },
): Promise<{ url: string; close: () => void }> {
  const server = net.createServer((client) => {
    let head = Buffer.alloc(0);
    client.on("error", () => {});
    const reject = (status: string, why: string) => {
      log.warn(`Blocked or failed proxy request: ${why}`);
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const onData = async (d: Buffer) => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > HEAD_LIMIT) reject("431 Request Header Fields Too Large", "header too large");
        return;
      }
      client.removeListener("data", onData);
      client.pause();
      const headText = head.subarray(0, end).toString("latin1");
      const body = head.subarray(end + 4);
      const [requestLine, ...headerLines] = headText.split("\r\n");
      const [method, target, version] = requestLine.split(" ");
      if (!opts.isReady()) return reject("503 Service Unavailable", "Tor is not ready yet");

      try {
        let host: string, port: number, firstBytes: Buffer;
        if (method === "CONNECT") {
          ({ host, port } = splitHostPort(target, 443));
          firstBytes = body;
        } else {
          const url = new URL(target);
          if (url.protocol !== "http:") throw new Error(`Unsupported scheme ${url.protocol}`);
          host = url.hostname.replace(/^\[|\]$/g, "");
          port = url.port ? Number(url.port) : 80;
          const headers = headerLines.filter(
            (h) => !/^(proxy-connection|proxy-authorization|connection|keep-alive):/i.test(h),
          );
          const rewritten =
            `${method} ${url.pathname}${url.search} ${version}\r\n` +
            headers.join("\r\n") +
            "\r\nConnection: close\r\n\r\n";
          firstBytes = Buffer.concat([Buffer.from(rewritten, "latin1"), body]);
        }
        const { socket, rest } = await socksConnect(socks, host, port, opts.isolation);
        socket.on("error", () => client.destroy());
        client.on("close", () => socket.destroy());
        socket.on("close", () => client.destroy());
        if (method === "CONNECT") client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) client.write(rest);
        if (firstBytes.length) socket.write(firstBytes);
        socket.pipe(client);
        client.pipe(socket);
        client.resume();
      } catch (e) {
        reject("502 Bad Gateway", errMsg(e));
      }
    };
    client.on("data", onData);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

/**
 * Forces every fetch() in this process through the Tor proxy, including any
 * request a library makes without passing a proxy. This is the kill switch for
 * the Session side.
 */
export function forceFetchThroughProxy(proxyUrl: string) {
  const realFetch = globalThis.fetch;
  const guarded = ((input: string | URL | Request, init?: RequestInit) => {
    const upgraded = upgradeSeedRequest(input, init);
    if (upgraded) return realFetch(upgraded.url, { ...upgraded.init, proxy: proxyUrl } as RequestInit);
    return realFetch(input, { ...(init ?? {}), proxy: proxyUrl } as RequestInit);
  }) as typeof fetch;
  Object.assign(guarded, realFetch);
  globalThis.fetch = guarded;
}

/**
 * Session.js asks the seed nodes for the list of Session nodes over plain HTTP.
 * Through Tor that would let an exit relay hand us a fake node list, so seed
 * requests are upgraded to HTTPS on port 4443 with the seeds' pinned certificates,
 * exactly like Session Desktop does. A failed pin fails the request; there is no
 * fallback to plain HTTP.
 */
function upgradeSeedRequest(
  input: string | URL | Request,
  init?: RequestInit,
): { url: string; init: RequestInit } | undefined {
  if (input instanceof Request) return undefined;
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    return undefined;
  }
  const ca = SEED_CERTS[url.hostname];
  if (!ca || url.protocol !== "http:") return undefined;
  url.protocol = "https:";
  url.port = "4443";
  return {
    url: url.href,
    init: { ...(init ?? {}), tls: { ca, rejectUnauthorized: true } } as RequestInit,
  };
}

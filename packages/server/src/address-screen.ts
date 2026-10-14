// Screening without an operator's proxy (STUDY-80 P1, DV-325, owner 2026-10-04: C — beyond Convex): a small proxy in the
// process, on 127.0.0.1, that does what Smokescreen does for Convex's cloud. It resolves the target's name,
// refuses it with a 407 when an address is in a denied range, and otherwise connects to the address it
// checked — so a name that resolves differently the second time (DNS rebinding) cannot get around it.
// Requests reach it exactly as they would reach `--http-proxy` (STUDY-80 §3.2), with the same refusal.
//
// - `metadata`: link-local addresses (169.254.0.0/16, fe80::/10: the cloud metadata endpoints) and the
//   other known metadata addresses (AWS's fd00:ec2::254, Alibaba's 100.100.100.200).
// - `private`: those, plus loopback, RFC 1918, CGNAT, unique-local, multicast, reserved and unspecified
//   ranges (Smokescreen's default classes), with IPv4-mapped and NAT64 IPv6 forms checked as IPv4.
//
// An `https:` target is a `CONNECT` tunnel (TLS stays end to end; the tunnel is reused). An `http:` one is
// forwarded once per connection, so each request is checked: the client is told `Connection: close`, and the
// connection ends where the response does. The target is not told to close, as a client without the screen
// would not tell it: a target that answers before reading the body keeps reading it, where a closing one
// would reset the connection under the body still coming, and lose its answer. A target it cannot connect
// to gets a `502` carrying the socket's error code and a secret (STUDY-142): the action's `fetch` then fails as
// it would have without the screen ("Connection refused", …), where a real proxy's answer is its own.
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { SCREEN_FAILURE_HEADER } from "./http-proxy.ts";

export type AddressScreen = "none" | "metadata" | "private";

export const ADDRESS_SCREENS: readonly AddressScreen[] = ["none", "metadata", "private"];

/** The default without an operator's proxy (DV-325, owner 2026-10-04: C). */
export const DEFAULT_ADDRESS_SCREEN: AddressScreen = "metadata";

/** `denyAddresses` / `BUNVEX_DENY_ADDRESSES` / `--deny-addresses`, checked; the default when unset. */
export function addressScreen(value: string | undefined): AddressScreen {
  if (value === undefined || value === "") return DEFAULT_ADDRESS_SCREEN;
  if (!(ADDRESS_SCREENS as readonly string[]).includes(value))
    throw new Error(
      `invalid value '${value}' for the denied addresses: possible values: ${ADDRESS_SCREENS.join(", ")}`,
    );
  return value as AddressScreen;
}

type Range = [base: bigint, bits: number, width: 32 | 128];

const v4 = (s: string): bigint => s.split(".").reduce((a, o) => (a << 8n) | BigInt(Number(o)), 0n);
function v6(s: string): bigint {
  let text = s;
  // A trailing dotted IPv4 (::ffff:1.2.3.4) as two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const n = v4(dotted[1]!);
    text = `${text.slice(0, dotted.index)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const a = head ? head.split(":") : [];
  const b = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = tail === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(Number.parseInt(g || "0", 16)), 0n);
}
const r4 = (cidr: string): Range => {
  const [ip = "", bits] = cidr.split("/");
  return [v4(ip), Number(bits), 32];
};
const r6 = (cidr: string): Range => {
  const [ip = "", bits] = cidr.split("/");
  return [v6(ip), Number(bits), 128];
};

const METADATA: Range[] = [r4("169.254.0.0/16"), r4("100.100.100.200/32"), r6("fe80::/10"), r6("fd00:ec2::254/128")];
const PRIVATE: Range[] = [
  ...METADATA,
  r4("0.0.0.0/8"),
  r4("10.0.0.0/8"),
  r4("100.64.0.0/10"),
  r4("127.0.0.0/8"),
  r4("172.16.0.0/12"),
  r4("192.0.0.0/24"),
  r4("192.0.2.0/24"),
  r4("192.168.0.0/16"),
  r4("198.18.0.0/15"),
  r4("198.51.100.0/24"),
  r4("203.0.113.0/24"),
  r4("224.0.0.0/4"),
  r4("240.0.0.0/4"),
  r6("::/128"),
  r6("::1/128"),
  r6("fc00::/7"),
  r6("ff00::/8"),
  r6("2001:db8::/32"),
];

const inRange = (n: bigint, width: 32 | 128, [base, bits, w]: Range) =>
  w === width && n >> BigInt(width - bits) === base >> BigInt(width - bits);

/** Whether `address` (an IP literal) is refused under `screen`. */
export function isDenied(address: string, screen: AddressScreen): boolean {
  if (screen === "none") return false;
  const ranges = screen === "metadata" ? METADATA : PRIVATE;
  if (net.isIPv4(address)) {
    const n = v4(address);
    return ranges.some((r) => inRange(n, 32, r));
  }
  if (!net.isIPv6(address)) return true; // not an address: refuse
  const n = v6(address.replace(/%.*$/, ""));
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) carry an IPv4 address: check it as one.
  if (n >> 32n === 0xffffn || n >> 32n === 0x64ff9b0000000000000000n) {
    const inner = n & 0xffffffffn;
    return ranges.some((r) => inRange(inner, 32, r));
  }
  return ranges.some((r) => inRange(n, 128, r));
}

/** The addresses `host` names: itself when it is one, else every address it resolves to. */
async function addressesOf(host: string): Promise<string[]> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return [bare];
  return (await lookup(bare, { all: true, verbatim: true })).map((a) => a.address);
}

/** The addresses to connect to, or null when the target is refused (any of its addresses, as Smokescreen). */
export async function checkedAddresses(host: string, screen: AddressScreen): Promise<string[] | null> {
  let all: string[];
  try {
    all = await addressesOf(host);
  } catch {
    return null; // a name that does not resolve is refused here, as by a proxy
  }
  if (all.length === 0 || all.some((a) => isDenied(a, screen))) return null;
  return all;
}

/**
 * A connection to the first of `addresses` that takes one, in order, as reqwest tries a name's addresses
 * (`localhost` is `::1` first, and a server may listen on `127.0.0.1` only); the last failure otherwise.
 */
function connectAny(port: number, addresses: string[]): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const attempt = (i: number) => {
      const up = net.connect(port, addresses[i]!);
      const failed = (e: Error) => (i + 1 < addresses.length ? attempt(i + 1) : reject(e));
      up.once("error", failed);
      up.once("connect", () => {
        up.off("error", failed);
        resolve(up);
      });
    };
    attempt(0);
  });
}

const REFUSED = "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const BAD = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const HOP_BY_HOP = /\r\n(proxy-authorization|proxy-connection|connection|keep-alive): [^\r\n]*/gi;

/**
 * Forward an `http:` target's response to `method`, its head saying `Connection: close`, and end the client's
 * connection where the response ends (RFC 9112 §6.3: no body, `Content-Length`, chunked, or the target's close).
 * The proxy serves one request per connection: a client that kept the connection alive would send its next
 * request into a closing socket (ECONNRESET). Interim (1xx) heads pass as they are; a body sent after the
 * response has ended is read and dropped.
 */
function forwardResponse(up: net.Socket, sock: net.Socket, method: string) {
  let buf: Buffer = Buffer.alloc(0);
  let state: "head" | "length" | "size" | "chunk" | "trailers" | "close" | "done" = "head";
  let left = 0;
  const finish = () => {
    state = "done";
    up.off("data", onData);
    sock.unpipe(up);
    up.destroy();
    sock.end();
    sock.resume();
  };
  /** Forward up to `left` bytes of `buf`; true when they are all out. */
  const take = () => {
    const n = Math.min(left, buf.length);
    if (n > 0) sock.write(buf.subarray(0, n));
    buf = buf.subarray(n);
    left -= n;
    return left === 0;
  };
  /** The next CRLF-ended line of `buf`, forwarded, without its CRLF; null until it is complete. */
  const line = () => {
    const end = buf.indexOf("\r\n");
    if (end < 0) return null;
    const text = buf.subarray(0, end).toString("latin1");
    sock.write(buf.subarray(0, end + 2));
    buf = buf.subarray(end + 2);
    return text;
  };
  const head = () => {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return false;
    const text = buf.subarray(0, end).toString("latin1");
    buf = buf.subarray(end + 4);
    const status = Number(text.split(" ")[1]);
    if (status >= 100 && status < 200 && status !== 101) {
      sock.write(Buffer.from(`${text}\r\n\r\n`, "latin1"));
      return true;
    }
    sock.write(Buffer.from(`${text.replace(HOP_BY_HOP, "")}\r\nConnection: close\r\n\r\n`, "latin1"));
    const header = (name: string) => new RegExp(`\r\n${name}:[ \t]*([^\r\n]*)`, "i").exec(text)?.[1]?.trim();
    const length = header("content-length");
    if (status === 101) state = "close";
    else if (method === "HEAD" || status === 204 || status === 304) finish();
    else if (/(^|,)\s*chunked\s*$/i.test(header("transfer-encoding") ?? "")) state = "size";
    else if (length !== undefined && /^\d+$/.test(length)) {
      left = Number(length);
      state = "length";
      if (left === 0) finish();
    } else state = "close";
    return true;
  };
  const onData = (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    for (;;) {
      if (state === "head") {
        if (!head()) return;
      } else if (state === "length") {
        if (!take()) return;
        finish();
      } else if (state === "size") {
        const size = line();
        if (size === null) return;
        left = Number.parseInt(size.split(";")[0]!.trim(), 16);
        if (Number.isNaN(left)) return void sock.destroy();
        if (left === 0) state = "trailers";
        else {
          left += 2; // the data's CRLF
          state = "chunk";
        }
      } else if (state === "chunk") {
        if (!take()) return;
        state = "size";
      } else if (state === "trailers") {
        const trailer = line();
        if (trailer === null) return;
        if (trailer === "") finish();
      } else if (state === "close") {
        if (buf.length > 0) sock.write(buf);
        buf = Buffer.alloc(0);
        return;
      } else return;
    }
  };
  up.on("data", onData);
  // A target that closes before its head is complete: the client's connection closes too (it would wait). One
  // that closes in the body ends the client's connection, which then reads a body that stopped short.
  up.once("end", () => {
    if (state === "head") sock.destroy();
    else if (state !== "done") sock.end();
  });
}

/** Start the screening proxy (bound at once); its URL goes where `--http-proxy`'s would. */
export function startAddressScreen(screen: AddressScreen) {
  const failureToken = randomBytes(16).toString("hex");
  const server = net.createServer((sock) => {
    sock.on("error", () => sock.destroy());
    let buf = Buffer.alloc(0);
    const onData = async (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > 64 * 1024) sock.end(BAD);
        return;
      }
      sock.off("data", onData);
      sock.pause();
      const head = buf.subarray(0, end).toString("latin1");
      const rest = buf.subarray(end + 4);
      const [method = "", target = ""] = (head.split("\r\n")[0] ?? "").split(" ");
      let host: string;
      let port: number;
      let path = "";
      if (method === "CONNECT") {
        const i = target.lastIndexOf(":");
        host = target.slice(0, i);
        port = Number(target.slice(i + 1));
      } else {
        let u: URL;
        try {
          u = new URL(target);
        } catch {
          return sock.end(BAD);
        }
        host = u.hostname;
        port = Number(u.port || 80);
        path = `${u.pathname}${u.search}`;
      }
      const addresses = await checkedAddresses(host, screen);
      if (addresses === null || !Number.isInteger(port)) return sock.end(REFUSED);
      let up: net.Socket;
      try {
        up = await connectAny(port, addresses);
      } catch (e) {
        // Not reached: the client hears why (`proxiedFetch` turns it into the failure it would have had
        // without the screen).
        const code = (e as NodeJS.ErrnoException).code ?? "ECONNRESET";
        return sock.end(
          `HTTP/1.1 502 Bad Gateway\r\n${SCREEN_FAILURE_HEADER}: ${failureToken} ${code}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        );
      }
      up.on("error", () => sock.destroy());
      if (method === "CONNECT") {
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) up.write(rest);
        up.pipe(sock);
      } else {
        // The head and what came of the body with it in one write, the target's connection kept alive.
        const lines = head.replace(target, path).replace(HOP_BY_HOP, "");
        up.write(Buffer.concat([Buffer.from(`${lines}\r\n\r\n`, "latin1"), rest]));
        forwardResponse(up, sock, method);
      }
      sock.pipe(up);
      sock.resume();
    };
    sock.on("data", onData);
  });
  server.listen(0, "127.0.0.1"); // Bun binds a TCP listener synchronously
  server.unref();
  const { port } = server.address() as net.AddressInfo;
  return { url: `http://127.0.0.1:${port}`, failureToken, stop: () => server.close() };
}

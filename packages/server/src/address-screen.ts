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
// forwarded once per connection (`Connection: close`), so each request is checked.
import { lookup } from "node:dns/promises";
import net from "node:net";

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

/** The address to connect to, or null when the target is refused (any of its addresses, as Smokescreen). */
export async function checkedAddress(host: string, screen: AddressScreen): Promise<string | null> {
  let all: string[];
  try {
    all = await addressesOf(host);
  } catch {
    return null; // a name that does not resolve is refused here, as by a proxy
  }
  if (all.length === 0 || all.some((a) => isDenied(a, screen))) return null;
  return all[0]!;
}

const REFUSED = "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const BAD = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const HOP_BY_HOP = /\r\n(proxy-authorization|proxy-connection|connection|keep-alive): [^\r\n]*/gi;

/** Start the screening proxy (bound at once); its URL goes where `--http-proxy`'s would. */
export function startAddressScreen(screen: AddressScreen) {
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
      const address = await checkedAddress(host, screen);
      if (address === null || !Number.isInteger(port)) return sock.end(REFUSED);
      const up = net.connect(port, address);
      up.on("error", () => sock.destroy());
      up.on("connect", () => {
        if (method === "CONNECT") sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        else {
          const lines = head.replace(target, path).replace(HOP_BY_HOP, "");
          up.write(Buffer.from(`${lines}\r\nConnection: close\r\n\r\n`, "latin1"));
        }
        if (rest.length > 0) up.write(rest);
        up.pipe(sock);
        sock.pipe(up);
        sock.resume();
      });
    };
    sock.on("data", onData);
  });
  server.listen(0, "127.0.0.1"); // Bun binds a TCP listener synchronously
  server.unref();
  const { port } = server.address() as net.AddressInfo;
  return { url: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

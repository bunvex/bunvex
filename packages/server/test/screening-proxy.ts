// A screening proxy for tests (STUDY-80), as Smokescreen behaves for Convex: an `http:` target comes as an
// absolute-form request, an `https:` one as a `CONNECT`; a refused host gets `407 Proxy Authentication
// Required` (with Smokescreen's `X-Smokescreen-Error`), any other is forwarded or tunnelled. One request
// per connection (the target closes it, so the client opens a new one). Every request is recorded with its `Proxy-Authorization`.
import net from "node:net";

export type ProxiedRequest = { method: string; target: string; auth: string | null };

/** `refuse(host, port)`: true to answer 407. */
export async function startScreeningProxy(refuse: (host: string, port: number) => boolean) {
  const seen: ProxiedRequest[] = [];
  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.once("data", (buf) => {
      const head = buf.toString("latin1");
      const [line = ""] = head.split("\r\n");
      const [method = "", target = ""] = line.split(" ");
      const auth = /\r\nproxy-authorization: ([^\r\n]*)/i.exec(head)?.[1] ?? null;
      seen.push({ method, target, auth });
      const refused = () =>
        sock.end(
          "HTTP/1.1 407 Proxy Authentication Required\r\nX-Smokescreen-Error: Egress proxying is denied to host\r\n" +
            "Content-Length: 6\r\nConnection: close\r\n\r\ndenied",
        );
      if (method === "CONNECT") {
        const i = target.lastIndexOf(":");
        const host = target.slice(0, i);
        const port = Number(target.slice(i + 1));
        if (refuse(host, port)) return refused();
        const up = net.connect(port, host, () => {
          sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          up.pipe(sock);
          sock.pipe(up);
        });
        up.on("error", () => sock.destroy());
        return;
      }
      let u: URL;
      try {
        u = new URL(target);
      } catch {
        return sock.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      }
      const port = Number(u.port || 80);
      if (refuse(u.hostname, port)) return refused();
      const up = net.connect(port, u.hostname, () => {
        // The origin-form request, without the proxy's header, on a connection closed after it.
        const forwarded = head
          .replace(target, `${u.pathname}${u.search}`)
          .replace(/\r\n(proxy-authorization|proxy-connection|connection|keep-alive): [^\r\n]*/gi, "")
          .replace(/\r\n\r\n/, "\r\nConnection: close\r\n\r\n");
        up.write(Buffer.from(forwarded, "latin1"));
        up.pipe(sock);
        sock.pipe(up); // the rest of a body
      });
      up.on("error", () => sock.destroy());
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as net.AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, stop: () => server.close() };
}

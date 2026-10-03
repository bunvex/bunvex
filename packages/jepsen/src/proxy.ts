// A TCP proxy (STUDY-57 §4). Between the clients and the server: the network nemesis cuts every connection
// through it, or refuses new ones for a while (a partition); the crash nemesis points it at the restarted
// server, so the clients keep one address. Between the server and a remote store: the same faults, on the
// store's connections.
import type { Socket, TCPSocketListener } from "bun";

type Pair = { client: Socket<Pair>; upstream: Socket<Pair> | null; pending: Uint8Array[] };

export class TcpProxy {
  private listener: TCPSocketListener<Pair> | null = null;
  private readonly pairs = new Set<Pair>();
  /** While true, new connections are closed as soon as they open. */
  blocked = false;

  constructor(
    public upstreamPort: number,
    readonly upstreamHost = "127.0.0.1",
  ) {}

  get port(): number {
    if (!this.listener) throw new Error("the proxy is not listening");
    return this.listener.port;
  }

  listen(): number {
    const proxy = this;
    this.listener = Bun.listen<Pair>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(client) {
          if (proxy.blocked) {
            client.end();
            return;
          }
          const pair: Pair = { client, upstream: null, pending: [] };
          client.data = pair;
          proxy.pairs.add(pair);
          Bun.connect<Pair>({
            hostname: proxy.upstreamHost,
            port: proxy.upstreamPort,
            socket: {
              open(upstream) {
                upstream.data = pair;
                pair.upstream = upstream;
                for (const chunk of pair.pending) upstream.write(chunk);
                pair.pending = [];
              },
              data(_upstream, chunk) {
                pair.client.write(chunk);
              },
              close() {
                proxy.cut(pair);
              },
              error() {
                proxy.cut(pair);
              },
            },
          }).catch(() => proxy.cut(pair));
        },
        data(client, chunk) {
          const pair = client.data;
          if (!pair) return;
          if (pair.upstream) pair.upstream.write(chunk);
          else pair.pending.push(new Uint8Array(chunk));
        },
        close(client) {
          if (client.data) proxy.cut(client.data);
        },
        error(client) {
          if (client.data) proxy.cut(client.data);
        },
      },
    });
    return this.listener.port;
  }

  /** Cut every connection through the proxy, both ways, at once. */
  dropAll(): number {
    const n = this.pairs.size;
    for (const pair of [...this.pairs]) this.cut(pair);
    return n;
  }

  private cut(pair: Pair) {
    if (!this.pairs.delete(pair)) return;
    pair.client.end();
    pair.upstream?.end();
  }

  close() {
    this.dropAll();
    this.listener?.stop(true);
    this.listener = null;
  }
}

// A TCP proxy that can freeze (K20): in front of a real store, it forwards bytes both ways until `freeze()`;
// from then on it forwards nothing, in either direction, on every connection, old or new. New connections are
// still accepted. That is what a client sees when its database stops answering without closing anything (a
// SIGSTOPped server whose kernel still accepts and acknowledges, a paused VM, a network that silently drops
// packets). `thaw()` delivers what was held, in order, and forwards again.
import { createServer, type Server, type Socket, connect as tcpConnect } from "node:net";

export type ProxiedConnection = {
  /** When the client first sent bytes during a freeze (a call waiting for an answer), if it did. */
  sentWhileFrozenAt: number | null;
  /** When the CLIENT closed (or half-closed) its side, if it did. */
  clientClosedAt: number | null;
};

export type FreezableProxy = {
  host: string;
  port: number;
  connections: ProxiedConnection[];
  freeze(): void;
  thaw(): void;
  close(): Promise<void>;
};

export async function freezableProxy(target: { host: string; port: number }): Promise<FreezableProxy> {
  let frozen = false;
  const connections: ProxiedConnection[] = [];
  const live = new Set<{ client: Socket; server: Socket; up: Buffer[]; down: Buffer[]; serverGone: boolean }>();
  const server: Server = createServer((client) => {
    const upstream = tcpConnect(target.port, target.host);
    const info: ProxiedConnection = { sentWhileFrozenAt: null, clientClosedAt: null };
    connections.push(info);
    const c = { client, server: upstream, up: [] as Buffer[], down: [] as Buffer[], serverGone: false };
    live.add(c);
    let ending = false; // closed by the proxy (the server went away), not by the client
    const end = () => {
      ending = true;
      live.delete(c);
      client.destroy();
      upstream.destroy();
    };
    client.on("data", (d: Buffer) => {
      if (!frozen) return void upstream.write(d);
      info.sentWhileFrozenAt ??= Date.now();
      c.up.push(d);
    });
    upstream.on("data", (d: Buffer) => (frozen ? c.down.push(d) : client.write(d)));
    const clientGone = () => {
      if (!ending) info.clientClosedAt ??= Date.now();
      end();
    };
    client.on("end", clientGone);
    client.on("close", clientGone);
    client.on("error", clientGone);
    // A frozen server closes nothing: hold its close until the thaw.
    const serverGone = () => {
      if (frozen) c.serverGone = true;
      else end();
    };
    upstream.on("end", serverGone);
    upstream.on("close", serverGone);
    upstream.on("error", serverGone);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return {
    host: "127.0.0.1",
    port,
    connections,
    freeze() {
      frozen = true;
    },
    thaw() {
      frozen = false;
      for (const c of [...live]) {
        for (const d of c.up.splice(0)) c.server.write(d);
        for (const d of c.down.splice(0)) c.client.write(d);
        if (c.serverGone) {
          live.delete(c);
          c.client.destroy();
        }
      }
    },
    async close() {
      for (const c of live) {
        c.client.destroy();
        c.server.destroy();
      }
      live.clear();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

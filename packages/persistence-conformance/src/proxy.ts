// A TCP proxy that can freeze (K20): in front of a real store, it forwards bytes both ways until `freeze()`;
// from then on it forwards nothing, in either direction, on every connection, old or new. New connections are
// still accepted. That is what a client sees when its database stops answering without closing anything (a
// SIGSTOPped server whose kernel still accepts and acknowledges, a paused VM, a network that silently drops
// packets). `thaw()` delivers what was held, in order, and forwards again.
//
// K21 (retries, STUDY-25 L4/L5) arms it to act on the requests a client sends: `resetOn` resets the
// connection that sends a matching request (a connection the server or the network closed), and
// `loseAnswersAfterCommit` lets the first COMMIT after a matching request through and then drops every
// answer, so the commit takes effect and the client never learns it did.
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
  /** Reset the connections of the next `n` requests that match `pattern`, instead of forwarding them. */
  resetOn(pattern: RegExp, n?: number): void;
  /**
   * Once a request matches `marker` (a group's rows), forward the next COMMIT, on any connection, and from then
   * on drop every answer, on every connection, until `keepAnswers()`.
   */
  loseAnswersAfterCommit(marker: RegExp): void;
  keepAnswers(): void;
  /** What the armed triggers did. */
  fired: { resets: number; loseAnswers: boolean };
  close(): Promise<void>;
};

/**
 * Whether a request commits a transaction: a COMMIT statement (MySQL, a simple Postgres query), MongoDB's
 * commitTransaction, or a Postgres Bind of a statement this connection prepared as COMMIT (postgres.js prepares
 * it once per connection and then sends only its name; `commitNames` learns them from Parse messages).
 */
function isCommit(text: string, commitNames: Set<string>): boolean {
  for (const m of text.matchAll(/P[\s\S]{4}([^\0]+)\0commit\0/gi)) commitNames.add(m[1]);
  // Not "autocommit", which MongoDB sends with every command of a transaction.
  if (/commitTransaction|\bcommit\b/i.test(text)) return true;
  for (const name of commitNames) if (text.includes(`\0${name}\0`) && /B[\s\S]{4}\0/.test(text)) return true;
  return false;
}

export async function freezableProxy(target: { host: string; port: number }): Promise<FreezableProxy> {
  let frozen = false;
  let losing = false;
  let resetPattern: RegExp | null = null;
  let resetsLeft = 0;
  let loseMarker: RegExp | null = null;
  let markerSeen = false;
  const fired = { resets: 0, loseAnswers: false };
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
    const commitNames = new Set<string>();
    client.on("data", (d: Buffer) => {
      const text = d.toString("latin1");
      const commit = isCommit(text, commitNames);
      if (resetPattern && resetsLeft > 0 && resetPattern.test(text)) {
        resetsLeft--;
        fired.resets++;
        if (resetsLeft === 0) resetPattern = null;
        return end();
      }
      if (loseMarker) {
        if (!markerSeen) markerSeen = loseMarker.test(text);
        else if (commit) {
          loseMarker = null;
          fired.loseAnswers = true;
          losing = true;
        }
      }
      if (!frozen) return void upstream.write(d);
      info.sentWhileFrozenAt ??= Date.now();
      c.up.push(d);
    });
    upstream.on("data", (d: Buffer) => {
      if (losing) return;
      if (frozen) c.down.push(d);
      else client.write(d);
    });
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
    resetOn(pattern, n = 1) {
      resetPattern = pattern;
      resetsLeft = n;
    },
    loseAnswersAfterCommit(marker) {
      loseMarker = marker;
      markerSeen = false;
    },
    keepAnswers() {
      losing = false;
      loseMarker = null;
    },
    fired,
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

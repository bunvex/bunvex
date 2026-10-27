// A connect that does not finish within the call's timeout is a `DatabaseTimeoutError`, as Convex's: mysql_async
// 0.37 has no connect timeout of its own, and Convex bounds `pool.get_conn()` by the same `with_timeout` as every
// statement (`crates/mysql/src/connection.rs`, `acquire_internal`). mysql2 has one (`connectTimeout`, set to the
// call's timeout), and its `connect ETIMEDOUT` must not be read as an IO error: since Convex's 9203a3e an
// `Io(TimedOut)` is not operational, so the committer would stop instead of retrying the flush (the K21 failure of
// merge-group run 40587403398, when mysql2's timer fired before the call's).
//   - Without a server: mysql2's own connect-timeout error is recognised, and an operating system's is not.
//   - With MYSQL_URL (an EMPTY scratch database; CI's MySQL job): the reconnect of a flush and of its retry hang
//     behind a proxy, mysql2's timer fires first, and the committer retries until the store answers again.
import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket, connect as tcpConnect } from "node:net";
import { Engine } from "@bunvex/core";
import { DatabaseTimeoutError } from "@bunvex/core/persistence";
import { defineSchema, defineTable } from "@bunvex/core/schema";
import mysql from "mysql2/promise";
import { connectTimedOut, MysqlPersistence } from "../src/mysql.ts";

const { MYSQL_URL } = process.env;

/** A TCP server that accepts connections and never answers (a MySQL whose greeting never arrives). */
async function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((s) => {
    sockets.add(s);
    s.on("error", () => {});
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as { port: number }).port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

describe("mysql2's connect timeout", () => {
  test("is recognised as the call's timeout; an operating system's ETIMEDOUT is not", async () => {
    const silent = await silentServer();
    try {
      const err = await mysql
        .createConnection({ host: "127.0.0.1", port: silent.port, user: "root", connectTimeout: 50 })
        .then(
          () => null,
          (e) => e,
        );
      expect(err?.code).toBe("ETIMEDOUT");
      expect(connectTimedOut(err)).toBe(true);
    } finally {
      await silent.close();
    }
    const os = Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:3306"), {
      code: "ETIMEDOUT",
      errno: -110,
      syscall: "connect",
    });
    expect(connectTimedOut(os)).toBe(false);
    expect(connectTimedOut(Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }))).toBe(false);
  });
});

/** A TCP proxy to `target`: `kill()` drops every connection; while `hang(true)`, new ones are left unanswered. */
async function proxyTo(target: { host: string; port: number }) {
  const pairs = new Set<[Socket, Socket]>();
  let hanging = false;
  const silent = new Set<Socket>();
  const server: Server = createServer((client) => {
    client.on("error", () => {});
    if (hanging) {
      silent.add(client);
      client.on("close", () => silent.delete(client));
      return;
    }
    const upstream = tcpConnect(target.port, target.host);
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
    const pair: [Socket, Socket] = [client, upstream];
    pairs.add(pair);
    client.on("close", () => pairs.delete(pair));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as { port: number }).port,
    hang(on: boolean) {
      hanging = on;
    },
    kill() {
      for (const [c, u] of pairs) {
        c.destroy();
        u.destroy();
      }
    },
    async close() {
      this.kill();
      for (const s of silent) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

describe.if(!!MYSQL_URL)("MySQL: a flush whose reconnect times out", () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    for (const f of cleanups.reverse()) await f().catch(() => {});
  });

  test("is retried by the committer, and acknowledged once the store answers", async () => {
    const raw = await mysql.createConnection(MYSQL_URL!);
    await raw.query(`drop table if exists documents, indexes, leases, read_only, persistence_globals`);
    await raw.end();
    const target = new URL(MYSQL_URL!);
    const proxy = await proxyTo({ host: target.hostname, port: Number(target.port || 3306) });
    cleanups.push(() => proxy.close());
    const via = new URL(MYSQL_URL!);
    via.hostname = "127.0.0.1";
    via.port = String(proxy.port);
    const store = await MysqlPersistence.open(via.toString(), 4, {
      requireSsl: !process.env.DO_NOT_REQUIRE_SSL,
      timeoutMs: 10_000,
    });
    // mysql2's connect timer well before the call's: the error is mysql2's `connect ETIMEDOUT`, deterministically
    // (in CI the two race at the same length, and a timer of the call's that fires a hair early re-arms).
    type Inner = { pool: { pool: { config: { connectionConfig: { connectTimeout: number } } } } };
    (store as unknown as Inner).pool.pool.config.connectionConfig.connectTimeout = 200;
    const retries: unknown[] = [];
    const schema = defineSchema({ items: defineTable({}) });
    const e = await new Engine(schema, store, {
      lease: { ttlMs: 60_000 },
      flushRetry: { initialBackoffMs: 1, maxBackoffMs: 1, onRetry: (err) => retries.push(err) },
    }).init();
    cleanups.push(() => e.close());
    await e.mutation((db) => db.insert("items", {}));

    // Every connection is lost, and new ones hang (the flush's, its retries'), until the committer has retried
    // twice: the second is a retry's reconnect timing out.
    proxy.hang(true);
    proxy.kill();
    await Bun.sleep(100);
    const committed = e.mutation((db) => db.insert("items", {}));
    const deadline = Date.now() + 10_000;
    while (retries.length < 2 && e.committer.stopped === null && Date.now() < deadline) await Bun.sleep(10);
    proxy.hang(false);
    await committed;

    expect(e.committer.stopped).toBeNull();
    expect(retries.length).toBeGreaterThanOrEqual(2);
    expect(retries.every((r) => r instanceof DatabaseTimeoutError)).toBe(true);
    expect(await e.query((db) => db.query("items").collect())).toHaveLength(2);
  }, 30_000);
});

// A database server's store for execution workers (STUDY-194 step v): the store describes how another thread opens
// it to read (`reader()`), the reader opened from that description reads what the store wrote and cannot write, and
// the store's pool can be resized while calls run on it (the server gives the workers part of its connections).
//   With PG_URL and/or MYSQL_URL (EMPTY scratch databases; CI's Postgres and MySQL jobs). DO_NOT_REQUIRE_SSL as there.
import { describe, expect, test } from "bun:test";
import { Engine, type Persistence, type StoreReader } from "@bunvex/core";
import { defineSchema, defineTable } from "@bunvex/core/schema";
import { SQL } from "bun";
import { MysqlPersistence } from "../src/mysql.ts";
import { PostgresPersistence } from "../src/postgres.ts";

type Driver = {
  name: "postgres" | "mysql";
  url: string | undefined;
  open(url: string, pool: number): Promise<Persistence & Resizable>;
  openReader(url: string, pool: number, options: Record<string, unknown>): Promise<Persistence>;
};
type Resizable = { connections: number; setPoolSize(n: number): void; reader(): StoreReader | undefined };

const tls = { requireSsl: !process.env.DO_NOT_REQUIRE_SSL };
const DRIVERS: Driver[] = [
  {
    name: "postgres",
    url: process.env.PG_URL,
    open: (url, pool) => PostgresPersistence.open(url, pool, tls),
    openReader: (url, pool, options) => PostgresPersistence.openReader(url, pool, options),
  },
  {
    name: "mysql",
    url: process.env.MYSQL_URL,
    open: (url, pool) => MysqlPersistence.open(url, pool, tls),
    openReader: (url, pool, options) => MysqlPersistence.openReader(url, pool, options),
  },
];

const schema = defineSchema({ notes: defineTable({}) });

async function empty(d: Driver) {
  // Bun's MySQL client authenticates as MySQL 8's default asks only over TLS: its own certificates, unverified.
  const sql = d.name === "mysql" ? new SQL(d.url!, { tls: { rejectUnauthorized: false } }) : new SQL(d.url!);
  try {
    await sql.unsafe("drop table if exists documents, indexes, leases, read_only, persistence_globals");
  } finally {
    await sql.close();
  }
}

for (const d of DRIVERS)
  describe.skipIf(!d.url)(`${d.name}: a reader of the store`, () => {
    test("opens from the store's description, reads what the store wrote, and cannot write", async () => {
      await empty(d);
      const store = await d.open(d.url!, 4);
      const engine = await new Engine(schema, store).init();
      try {
        await engine.mutation((db) => db.insert("notes", {}));
        const description = store.reader();
        expect(description).toEqual({ driver: d.name, url: d.url!, options: expect.any(Object) });
        // Plain data: it crosses to the worker as JSON.
        const crossed = JSON.parse(JSON.stringify(description)) as { url: string; options: Record<string, unknown> };
        expect(crossed.options).toMatchObject(tls);
        const reader = await d.openReader(crossed.url, 2, crossed.options);
        try {
          expect(await reader.maxTs!()).toBe(await store.maxTs!());
          expect(await reader.getGlobal("no such global")).toBeNull();
          // A reader takes no lease, so a write fails as one without the lease does.
          await expect(Promise.resolve().then(() => reader.setGlobal("k", 1))).rejects.toThrow();
          expect((reader as unknown as Resizable).reader()).toBeUndefined();
        } finally {
          await reader.close();
        }
      } finally {
        await engine.close();
      }
    });

    test("the pool can be resized while calls run on it: they finish on the old one, the next use the new", async () => {
      await empty(d);
      const store = await d.open(d.url!, 4);
      const engine = await new Engine(schema, store).init();
      try {
        await engine.mutation((db) => db.insert("notes", {}));
        const top = await store.maxTs!();
        const running = Array.from({ length: 12 }, () => store.maxTs!());
        store.setPoolSize(2);
        expect(store.connections).toBe(2);
        expect(await Promise.all(running)).toEqual(Array(12).fill(top));
        expect(await store.maxTs!()).toBe(top);
        await engine.mutation((db) => db.insert("notes", {}));
        expect(await store.maxTs!()).toBeGreaterThan(top);
      } finally {
        await engine.close();
      }
    });
  });

// PERSIST-01 C11 measurements: what the ts index costs writers, and how fast the log reads back.
//   bun bench/readlog.ts write   [drivers]   engine write throughput with vs without the ts index
//   bun bench/readlog.ts catchup [drivers]   readLog over N commits (catch-up) and one poll at the tail
// drivers: comma-separated, from sqlite, memory, postgres, mysql, mongodb (default sqlite,postgres).
// Env: DIR (sqlite/memory files), PG_URL, MYSQL_URL, MONGO_URL (scratch databases: tables are dropped),
//      SECS (per write trial, default 5), RUNS (interleaved rounds, default 3), COMMITS (catch-up, default 100000).
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { encodeKey, type Persistence } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { insertItem, newEngine } from "../packages/persistence-conformance/src/workload.ts";
import { tid } from "./ids.ts";

const mode = process.argv[2] ?? "write";
const drivers = (process.argv[3] ?? "sqlite,postgres").split(",");
const DIR = process.env.DIR ?? `${import.meta.dir}/../.data/readlog`;
const SECS = Number(process.env.SECS ?? 5);
const RUNS = Number(process.env.RUNS ?? 3);
const COMMITS = Number(process.env.COMMITS ?? 100_000);
/** The largest int64: a log read up to every commit. */
const MAX_TS = (1n << 63n) - 1n;
mkdirSync(DIR, { recursive: true });

type Driver = {
  open(fresh: boolean): Promise<Persistence>;
  /** Drop (false) or build (true) the ts index on the store (closed or not). */
  setLogIndex(on: boolean): Promise<void>;
};

const sqliteFile = `${DIR}/readlog.db`;
const pgAdmin = async (q: string) => {
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.PG_URL!, { max: 1, onnotice: () => {} });
  await sql.unsafe(q);
  await sql.end();
};
const myAdmin = async (q: string) => {
  const mysql = await import("mysql2/promise");
  const c = await mysql.createConnection(process.env.MYSQL_URL!);
  await c.query(q).catch((e) => {
    if (![1061, 1091].includes(e.errno)) throw e; // exists already / missing already
  });
  await c.end();
};
const mongoIdx = async (on: boolean) => {
  const { MongoClient } = await import("mongodb");
  const c = new MongoClient(process.env.MONGO_URL!);
  await c.connect();
  const col = c.db().collection("indexes");
  if (on) await col.createIndex({ ts: 1 });
  else await col.dropIndex("ts_1").catch(() => {});
  await c.close();
};

const DRIVERS: Record<string, Driver> = {
  sqlite: {
    async open(fresh) {
      if (fresh) for (const s of ["", "-wal", "-shm"]) rmSync(`${sqliteFile}${s}`, { force: true });
      return new SqlitePersistence(sqliteFile, { durable: true });
    },
    async setLogIndex(on) {
      const db = new Database(sqliteFile);
      db.exec(on ? `create index if not exists indexes_by_ts on indexes (ts)` : `drop index if exists indexes_by_ts`);
      db.close();
    },
  },
  memory: {
    async open(fresh) {
      if (fresh) rmSync(`${DIR}/readlog.log`, { force: true });
      return MemoryPersistence.open(`${DIR}/readlog.log`, { durable: true });
    },
    async setLogIndex() {}, // an array of commits, always there
  },
  postgres: {
    async open(fresh) {
      if (fresh) await pgAdmin(`drop table if exists documents, indexes, bunvex_lease`);
      const { PostgresPersistence } = await import("@bunvex/persistence/postgres");
      return PostgresPersistence.open(process.env.PG_URL!, 70);
    },
    setLogIndex: (on) =>
      pgAdmin(on ? `create index if not exists indexes_by_ts on indexes (ts)` : `drop index if exists indexes_by_ts`),
  },
  mysql: {
    async open(fresh) {
      if (fresh) await myAdmin(`drop table if exists documents, indexes, bunvex_lease`);
      const { MysqlPersistence } = await import("@bunvex/persistence/mysql");
      return MysqlPersistence.open(process.env.MYSQL_URL!, 70);
    },
    setLogIndex: (on) =>
      myAdmin(on ? `alter table indexes add index indexes_by_ts (ts)` : `alter table indexes drop index indexes_by_ts`),
  },
  mongodb: {
    async open(fresh) {
      const { MongoPersistence } = await import("@bunvex/persistence/mongodb");
      return MongoPersistence.open(process.env.MONGO_URL!, { fresh, pool: 70 });
    },
    setLogIndex: mongoIdx,
  },
};

const report = (r: Record<string, unknown>) => console.log(JSON.stringify(r));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Commits per second through the engine: `writers` concurrent loops of one insert per mutation. */
async function writeTrial(d: Driver, withIndex: boolean, writers: number) {
  const st = await d.open(true);
  const e = await newEngine(st);
  if (!withIndex) await d.setLogIndex(false);
  await e.mutation(insertItem("warm"));
  let n = 0;
  const end = performance.now() + SECS * 1000;
  await Promise.all(
    Array.from({ length: writers }, async (_, w) => {
      while (performance.now() < end) {
        await e.mutation(insertItem(`t${w % 16}`));
        n++;
      }
    }),
  );
  const rate = n / SECS;
  await e.close();
  return rate;
}

async function write(name: string) {
  const d = DRIVERS[name];
  for (const writers of [64, 1]) {
    const on: number[] = [];
    const off: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      // Interleaved, alternating which goes first, so drift (cache, checkpoints, thermals) hits both.
      const order = r % 2 ? [false, true] : [true, false];
      for (const withIndex of order) (withIndex ? on : off).push(await writeTrial(d, withIndex, writers));
    }
    const cost = 1 - median(on) / median(off);
    report({
      m: "write",
      driver: name,
      writers,
      with_ts_index: on.map(Math.round),
      without: off.map(Math.round),
      median_cost_pct: Number((cost * 100).toFixed(1)),
    });
  }
}

/** Seed COMMITS commits straight through the driver (1 document, 3 index entries each, groups of 200),
 *  then read the whole log back by pages, and time a poll at the tail. */
async function catchup(name: string) {
  const d = DRIVERS[name];
  const st = await d.open(true);
  const leased = "acquireLease" in st;
  if (leased) await (st as any).acquireLease({ holder: "bench", ttlMs: 600_000 });
  let ts = (await st.maxTs?.()) ?? 0n;
  const t0 = performance.now();
  for (let c = 0; c < COMMITS; c++) {
    ts += BigInt(1 + Math.floor(Math.random() * 1000));
    const id = `d${c}`;
    st.apply(
      ts,
      [{ table: tid(1), id, json: `{"c":${c},"title":"an item","amount":42}`, prevTs: null }],
      [
        { index: tid(1), key: encodeKey([id]), table: tid(1), id },
        { index: tid(2), key: encodeKey([ts, id]), table: tid(1), id },
        { index: tid(3), key: encodeKey([`t${c % 16}`, ts, id]), table: tid(1), id },
      ],
    );
    if (c % 200 === 199) await st.flush();
  }
  await st.flush();
  const seedS = (performance.now() - t0) / 1000;
  const last = ts;
  for (const withIndex of name === "memory" ? [true] : [true, false]) {
    await d.setLogIndex(withIndex);
    // The first pass reads rows just written (Postgres then sets their hint bits and has no visibility map
    // for index-only scans yet); the later ones read them again.
    for (const [pass, page] of [
      [1, 1000],
      [2, 1000],
      [3, 100],
    ]) {
      let after = 0n;
      let n = 0;
      const t1 = performance.now();
      for (;;) {
        const cs = await st.readLog!(after, MAX_TS, page);
        if (!cs.length) break;
        n += cs.length;
        after = cs[cs.length - 1].ts;
      }
      const s = (performance.now() - t1) / 1000;
      // A poll at the tail: nothing new since `last` (what a follower's safety-net poll does).
      const polls: number[] = [];
      for (let i = 0; i < 50; i++) {
        const t = performance.now();
        await st.readLog!(last, MAX_TS, page);
        polls.push(performance.now() - t);
      }
      report({
        m: "catchup",
        driver: name,
        ts_index: withIndex,
        commits: n,
        pass,
        page,
        commits_per_s: Math.round(n / s),
        tail_poll_ms_p50: Number(median(polls).toFixed(3)),
        seed_s: Number(seedS.toFixed(1)),
      });
    }
  }
  if (leased) await (st as any).releaseLease();
  await st.close();
}

for (const name of drivers) await (mode === "catchup" ? catchup(name) : write(name));
process.exit(0);

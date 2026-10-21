// The SQLite page cache's size (AD-46, DV-550; STUDY-174 Q6): 256 MiB by default, BUNVEX_SQLITE_CACHE_SIZE in bytes
// otherwise, always set on the store's own connection (Bun's SQLite defaults differ by platform), and a value that
// does not parse refused before the store's file is touched.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLITE_CACHE_DEFAULT_BYTES,
  SQLITE_CACHE_MAX_BYTES,
  SqlitePersistence,
  sqliteCacheBytes,
} from "../src/persistence/sqlite.ts";

const dirs: string[] = [];
const saved = process.env.BUNVEX_SQLITE_CACHE_SIZE;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved === undefined) delete process.env.BUNVEX_SQLITE_CACHE_SIZE;
  else process.env.BUNVEX_SQLITE_CACHE_SIZE = saved;
});
function file() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-sqlite-cache-"));
  dirs.push(dir);
  return join(dir, "db.sqlite3");
}
/** The `cache_size` of the store's own connection: the pragma is per connection, so a second one would not tell. */
const cacheSize = (p: SqlitePersistence) =>
  ((p as unknown as { db: Database }).db.query("pragma cache_size").get() as { cache_size: number }).cache_size;

describe("BUNVEX_SQLITE_CACHE_SIZE", () => {
  test("unset or empty: 256 MiB, DV-550's default", () => {
    expect(SQLITE_CACHE_DEFAULT_BYTES).toBe(268_435_456);
    expect(sqliteCacheBytes({})).toBe(SQLITE_CACHE_DEFAULT_BYTES);
    expect(sqliteCacheBytes({ BUNVEX_SQLITE_CACHE_SIZE: "" })).toBe(SQLITE_CACHE_DEFAULT_BYTES);
  });

  test("bytes, parsed as INDEX_CACHE_SIZE: an unsigned integer, a leading + allowed, up to SQLite's limit", () => {
    expect(sqliteCacheBytes({ BUNVEX_SQLITE_CACHE_SIZE: "2048000" })).toBe(2_048_000);
    expect(sqliteCacheBytes({ BUNVEX_SQLITE_CACHE_SIZE: "+1" })).toBe(1);
    expect(sqliteCacheBytes({ BUNVEX_SQLITE_CACHE_SIZE: String(SQLITE_CACHE_MAX_BYTES) })).toBe(SQLITE_CACHE_MAX_BYTES);
  });

  test("anything else is refused with a message naming the variable, the range and the default", () => {
    for (const bad of [
      "0",
      "-1",
      "1.5",
      "1e6",
      "256MiB",
      " 1024",
      "abc",
      String(SQLITE_CACHE_MAX_BYTES + 1),
      "9".repeat(20),
    ])
      expect(() => sqliteCacheBytes({ BUNVEX_SQLITE_CACHE_SIZE: bad })).toThrow(
        `invalid value '${bad}' for the SQLite page cache (BUNVEX_SQLITE_CACHE_SIZE): a size in bytes, from 1 to ` +
          `${SQLITE_CACHE_MAX_BYTES}; the default is 268435456 (256 MiB)`,
      );
  });

  test("the store's connection gets it, in KiB rounded up, whatever the platform's default", () => {
    // Bun's own SQLite on Linux defaults to -2000 (KiB), the system SQLite on macOS to 2000 (pages): both are
    // replaced, so a store gets the same cache everywhere.
    const fresh = new Database(":memory:");
    expect([-2000, 2000]).toContain((fresh.query("pragma cache_size").get() as { cache_size: number }).cache_size);
    fresh.close();
    for (const [env, want] of [
      [undefined, -262_144],
      ["2048000", -2000],
      ["1", -1],
      ["1025", -2],
      ["1073741824", -1_048_576],
    ] as const) {
      if (env === undefined) delete process.env.BUNVEX_SQLITE_CACHE_SIZE;
      else process.env.BUNVEX_SQLITE_CACHE_SIZE = env;
      const p = new SqlitePersistence(file(), { durable: false });
      expect(cacheSize(p)).toBe(want);
      p.close();
    }
    // The option wins over the environment (`bunvex-local-backend` passes its own environment's value).
    process.env.BUNVEX_SQLITE_CACHE_SIZE = "2048000";
    const p = new SqlitePersistence(file(), { durable: false, cacheBytes: 4096 });
    expect(cacheSize(p)).toBe(-4);
    p.close();
  });

  test("a bad value fails the open before the store's file or its lock exists", () => {
    process.env.BUNVEX_SQLITE_CACHE_SIZE = "0";
    const path = file();
    expect(() => new SqlitePersistence(path, { durable: true })).toThrow("BUNVEX_SQLITE_CACHE_SIZE");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});

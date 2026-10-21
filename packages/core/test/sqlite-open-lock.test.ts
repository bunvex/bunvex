// A SQLite store that fails to open releases its single-writer lock (STUDY-174 S7): the lock is taken first, so an
// open that throws after it (the path cannot be opened, or the store cannot be written) must release it, or this
// process keeps the store locked against every later open, its own included, until it exits.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessLock } from "../src/persistence/lock.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o755);
    rmSync(d, { recursive: true, force: true });
  }
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-sqlite-lock-"));
  dirs.push(d);
  return d;
};

/** The lock is free: this process can take it (then gives it back). */
function lockIsFree(path: string): boolean {
  const lock = ProcessLock.tryTake(path);
  lock?.release();
  return lock !== null;
}

test("a path SQLite cannot open (a directory) leaves the lock free", () => {
  const path = join(tmp(), "store.sqlite3");
  mkdirSync(path);
  expect(() => new SqlitePersistence(path, { durable: true })).toThrow();
  expect(lockIsFree(path)).toBe(true);
});

// Root writes a read-only file anyway (CI in a container may run as root).
test.skipIf(process.getuid?.() === 0)(
  "a store that cannot be written (a new, read-only file) leaves the lock free, and opens once writable",
  async () => {
    const path = join(tmp(), "store.sqlite3");
    writeFileSync(path, ""); // a new store: its tables are still to be created
    chmodSync(path, 0o444);
    expect(() => new SqlitePersistence(path, { durable: true })).toThrow();
    expect(lockIsFree(path)).toBe(true);
    chmodSync(path, 0o644);
    const p = new SqlitePersistence(path, { durable: true });
    expect(lockIsFree(path)).toBe(false); // this one holds it
    await p.close();
  },
);

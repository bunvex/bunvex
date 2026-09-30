// The single-writer lock of the embedded stores (PERSIST-01 C7 for a file on one machine; STUDY-25 L9).
// Bun has no flock(), so the lock is a tiny SQLite database in EXCLUSIVE locking mode: once it has written,
// SQLite holds the file lock until the connection closes, and the kernel drops it when the process dies
// (kill -9 included). Another process — or another connection of this one — gets "database is locked".
// Convex's SQLite store has no such lock: two processes on one file lose writes (STUDY-25 §1.5).
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";

export class ProcessLock {
  private constructor(
    private db: Database,
    private path: string,
    /** Strictly increasing across every take of this store's lock. */
    readonly epoch: number,
  ) {}

  /** Take the lock next to `dataPath`, or null if another process (or connection) holds it. */
  static tryTake(dataPath: string): ProcessLock | null {
    const path = `${dataPath}.lock`;
    const db = new Database(path, { create: true });
    try {
      db.exec("pragma locking_mode = exclusive");
      db.exec("begin exclusive");
      db.exec("create table if not exists lease (epoch integer not null)");
      const row = db.query("select epoch from lease").get() as { epoch: number } | null;
      const epoch = (row?.epoch ?? 0) + 1;
      if (row) db.run("update lease set epoch = ?", [epoch]);
      else db.run("insert into lease values (?)", [epoch]);
      db.exec("commit");
      return new ProcessLock(db, path, epoch);
    } catch (e) {
      db.close();
      if (/locked|busy/i.test(String((e as Error).message))) return null;
      throw e;
    }
  }

  /** Who holds the lock, as recorded by its holder (best effort: the lock itself cannot be read). */
  static holderOf(dataPath: string): string {
    try {
      return readFileSync(`${dataPath}.lock.holder`, "utf8") || "another process";
    } catch {
      return "another process";
    }
  }

  recordHolder(holder: string) {
    writeFileSync(`${this.path}.holder`, holder);
  }

  release() {
    this.db.close();
  }
}

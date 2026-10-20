// STUDY-174 F6's baseline: plain bun:sqlite, no bunvex. A WAL database grows by 20 000 rows of 1 KB a step, and the
// process's resident memory is printed after each step with a given `cache_size` (KiB; 0: SQLite's default, 2 000).
// With bunvex's 262 144 (256 MiB) resident memory follows the file's size; with the default it stays flat. At the
// end it prints mimalloc's stats (Bun's allocator, which SQLite uses too): the page cache is its 5 KiB size class.
//
//   bun bench/soak/sqlite-page-cache.ts 262144 <dir>
//   bun bench/soak/sqlite-page-cache.ts 0 <dir>
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";

const kib = Number(process.argv[2] ?? 262144);
const path = join(process.argv[3] ?? ".", `page-cache-${kib}.sqlite3`);
const clean = () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
};
clean();
const db = new Database(path, { create: true });
db.exec(`pragma journal_mode = wal; pragma synchronous = off;${kib ? ` pragma cache_size = -${kib};` : ""}`);
db.exec("create table d (id integer primary key, v blob)");
const insert = db.prepare("insert into d (v) values (?)");
const blob = new Uint8Array(1000).fill(7);
const MB = 2 ** 20;
const rss0 = process.memoryUsage().rss;
for (let step = 1; step <= 10; step++) {
  db.transaction(() => {
    for (let i = 0; i < 20_000; i++) insert.run(blob);
  })();
  Bun.gc(true);
  const { rss, heapUsed } = process.memoryUsage();
  console.log(
    `cache_size=${kib || "default"} file=${(Bun.file(path).size / MB).toFixed(0)} MB rss +${((rss - rss0) / MB).toFixed(0)} MB heap ${(heapUsed / MB).toFixed(0)} MB`,
  );
}
(Bun.unsafe as unknown as { mimallocDump?: () => void }).mimallocDump?.();
db.close();
clean();

// STUDY-174 Q6: patches a *copy* of this repository so the SQLite store's `cache_size` comes from the environment,
// for ./bench.ts to compare two sizes with everything else the same. Never run it on a checkout you commit from.
//
//   BENCH_SQLITE_CACHE_KIB=262144  pragma cache_size = -262144 (256 MiB, what bunvex set before Q6)
//   BENCH_SQLITE_CACHE_KIB unset   no pragma: SQLite's default, as Convex (crates/sqlite/src/lib.rs:93-99)
//
// Either way the store prints `bench cache_size=<value>` on stderr when it opens, so a run can check what it got.
//
//   bun bench/sqlite-cache/patch-backend.ts <repo copy>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = join(process.argv[2] ?? ".", "packages/core/src/persistence/sqlite.ts");
const src = readFileSync(file, "utf8");
if (src.includes("BENCH_SQLITE_CACHE_KIB")) {
  console.log(`${file}: already patched`);
  process.exit(0);
}
// The pragma line, with or without bunvex's old cache_size.
const pragma = /pragma temp_store = memory;( pragma cache_size = -262144;)?`\);/;
if (!pragma.test(src)) throw new Error(`${file}: the pragma line was not found`);
// The inserted code is source text: its `${…}` are the patched file's, not this script's.
const patched = src.replace(
  pragma,
  () =>
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text for the patched file
    'pragma temp_store = memory;${process.env.BENCH_SQLITE_CACHE_KIB ? ` pragma cache_size = -${process.env.BENCH_SQLITE_CACHE_KIB};` : ""}`);\n' +
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text for the patched file
    '    if (!this.inMemory) console.error(`bench cache_size=${JSON.stringify(this.db.query("pragma cache_size").get())}`);',
);
writeFileSync(file, patched);
console.log(`${file}: patched`);

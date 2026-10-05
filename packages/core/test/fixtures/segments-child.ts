// The child of the search segments crash test: writes 200 documents and waits for them to be flushed into
// segments, writes 30 more (under the flush limit), says "written", and waits to be killed.
//   bun segments-child.ts <sqlite path> <blob directory>
import { v } from "@bunvex/values";
import { defineSchema, defineTable, Engine } from "../../src/index.ts";
import { SqlitePersistence } from "../../src/persistence/sqlite.ts";
import { fileBlobs } from "./segments-blobs.ts";

const [path, dir] = process.argv.slice(2);
const schema = defineSchema({
  notes: defineTable(v.any())
    .searchIndex("search_body", { searchField: "body", filterFields: ["kind"] })
    .vectorIndex("by_v", { vectorField: "v", dimensions: 2 }),
});
const note = (i: number) => ({ body: `note ${i} ${i % 3 ? "hello" : "world"}`, kind: `k${i % 2}`, v: [i % 5, 1] });

// Flushed past 20 KB of memory part: the 200 first documents are, the 30 last are not.
const e = await new Engine(schema, new SqlitePersistence(path!, { durable: true }), {
  searchSnapshots: fileBlobs(dir!),
  searchSegmentLimits: { textSoftLimitBytes: 20_000, vectorSoftLimitBytes: 20_000 },
}).init();
await e.searchReady();
await e.mutation(async (db) => {
  for (let i = 0; i < 200; i++) await db.insert("notes", note(i));
});
await e.searchFlushed();
await e.mutation(async (db) => {
  for (let i = 200; i < 230; i++) await db.insert("notes", note(i));
});
console.log("written");
await new Promise(() => {});

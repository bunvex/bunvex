// The tables of upstream's client tests (`src/client/index.test.ts`): a queue drained by deleting (`items`), marks
// scanned by an advancing commit-timestamp-shaped cursor and never deleted (`marks`, one `batches` row per batch),
// and letters scanned by a string cursor (`letters`, `letterBatches`). `jobs` is this package's own: a queue whose
// worker mutation throws on a job until it is `allowed`, for at-least-once processing.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  items: defineTable({ value: v.number() }),
  marks: defineTable({ seq: v.int64() }).index("seq", ["seq"]),
  batches: defineTable({ seqs: v.array(v.int64()) }),
  letters: defineTable({ letter: v.string() }).index("letter", ["letter"]),
  letterBatches: defineTable({ letters: v.array(v.string()) }),
  jobs: defineTable({ value: v.number() }),
  done: defineTable({ value: v.number() }),
  allowed: defineTable({}),
});

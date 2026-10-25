// Mutations that leave writes unawaited (STUDY-187 §2.1), as Convex's own tests (`udf-tests/convex/asyncTests.ts`):
// the writes are part of the mutation, Convex running every syscall to its end. `fresh*` insert into a table the
// insert creates; `count` reads one table.
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const dangling = mutationGeneric({
  args: { table: v.string() },
  handler: async ({ db }, { table }) => {
    void db.insert(table as never, {});
  },
});

export const doublyDangling = mutationGeneric({
  args: { table: v.string() },
  handler: async ({ db }, { table }) => {
    const two = async () => {
      await db.insert(table as never, {});
      await db.insert(table as never, {});
    };
    void two();
  },
});

export const afterRead = mutationGeneric({
  args: { table: v.string() },
  handler: async ({ db }, { table }) => {
    void db
      .query(table as never)
      .first()
      .then((d) => (d ? db.patch(d._id, { n: 7 } as never) : db.insert(table as never, { n: 7 } as never)));
  },
});

export const count = queryGeneric({
  args: { table: v.string() },
  handler: async ({ db }, { table }) => {
    const rows = await db.query(table as never).collect();
    return { rows: rows.length, n: rows.map((r) => (r as { n?: number }).n ?? null) };
  },
});

// A query's result changed after its handler returned (STUDY-188 §X19 a), as Convex's own test
// (`udf-tests/convex/asyncTests.ts`, `queryDangling`): a read left unawaited pushes into the array the handler
// returned. Convex serializes the result once the handler's promise is fulfilled, before the read can answer, so
// the push is never seen. `insert` writes the document the read finds.
import { mutationGeneric, queryGeneric } from "convex/server";

export const queryDangling = queryGeneric({
  args: {},
  handler: async ({ db }) => {
    const result: unknown[] = [];
    void db
      .query("objects")
      .first()
      .then((d) => result.push(d));
    return result;
  },
});

/** The same, in an object, and from a mutation. */
export const objectDangling = queryGeneric({
  args: {},
  handler: async ({ db }) => {
    const result: Record<string, unknown> = { a: 1 };
    void db
      .query("objects")
      .first()
      .then((d) => {
        result.b = d;
      });
    return result;
  },
});

export const mutationDangling = mutationGeneric({
  args: {},
  handler: async ({ db }) => {
    const result: unknown[] = [];
    void db
      .query("objects")
      .first()
      .then((d) => result.push(d));
    return result;
  },
});

/** A nested query's result, as its caller gets it. */
export const nestedDangling = queryGeneric({
  args: {},
  handler: async (ctx) => ctx.runQuery("ops:queryDangling" as never),
});

export const insert = mutationGeneric({
  args: {},
  handler: async ({ db }) => {
    await db.insert("objects", {});
  },
});

/** Pushes after 0 to 4 microtask hops, the read not involved: what each backend serializes. */
export const microtasks = queryGeneric({
  args: {},
  handler: async () => {
    const result: number[] = [];
    for (let n = 0; n <= 4; n++) {
      let p: Promise<unknown> = Promise.resolve();
      for (let i = 0; i < n; i++) p = p.then(() => {});
      void p.then(() => result.push(n));
    }
    return result;
  },
});

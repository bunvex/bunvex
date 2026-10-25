// A query used again after it ran, was iterated or was chained (STUDY-188 §X9): `steps` are applied in order to the
// same query object, and each step's outcome is kept (what it returned, or the error it threw). The object is
// `db.query("items")` itself (`init`), a query after its first operator (`scan`), an ordered one (`ordered`), one of
// an index that does not exist (`missing`: its start fails), or `db.system.query("_storage")` before (`sysinit`) and
// after (`sysscan`) its first operator.
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const seed = mutationGeneric({
  args: {},
  handler: async ({ db }) => {
    await db.insert("items", { n: 1 });
    await db.insert("items", { n: 2 });
  },
});

const outcome = async (f: () => unknown): Promise<string> => {
  try {
    const r = await f();
    if (typeof r === "string") return `ok:${r}`;
    if (Array.isArray(r)) return `ok:${r.length}`;
    if (r && typeof r === "object" && "page" in r) return `page:${(r as { page: unknown[] }).page.length}`;
    if (r && typeof r === "object" && "done" in r) return `next:${(r as { done: boolean }).done}`;
    if (r && typeof r === "object") return "ok:object";
    return `ok:${typeof r}`;
  } catch (e) {
    return `err:${(e as Error).constructor.name}:${(e as Error).message}`;
  }
};

export const run = queryGeneric({
  args: {
    base: v.union(
      v.literal("init"),
      v.literal("scan"),
      v.literal("ordered"),
      v.literal("missing"),
      v.literal("sysinit"),
      v.literal("sysscan"),
    ),
    steps: v.array(v.string()),
  },
  handler: async ({ db }, { base, steps }) => {
    const init = (base.startsWith("sys") ? db.system.query("_storage") : db.query("items")) as any;
    const q =
      base === "init" || base === "sysinit"
        ? init
        : base === "ordered"
          ? init.order("asc")
          : base === "missing"
            ? init.withIndex("nope")
            : init.fullTableScan();
    let it: any;
    const out: string[] = [];
    for (const step of steps) {
      out.push(
        await outcome(async () => {
          switch (step) {
            case "iter": {
              const rows = [];
              for await (const d of q) rows.push(d);
              return rows;
            }
            case "break": {
              const rows = [];
              for await (const d of q) {
                rows.push(d);
                break;
              }
              return rows;
            }
            case "collect":
              return q.collect();
            case "take":
              return q.take(1);
            case "first":
              return q.first();
            case "unique":
              return q.unique();
            case "paginate":
              return q.paginate({ numItems: 1, cursor: null });
            case "filter":
              return q.filter((f: any) => f.eq(f.field("n"), 1));
            case "order":
              return q.order("desc");
            case "limit":
              return q.limit(1);
            case "withIndex":
              return q.withIndex("by_creation_time");
            case "count":
              return q.count();
            case "start":
              it = q[Symbol.asyncIterator]();
              return it === q ? "self" : "other";
            case "itnext":
              return it.next();
            case "itreturn":
              return it.return();
            case "next":
              return q.next();
            case "return":
              return q.return();
            default:
              throw new Error(`unknown step ${step}`);
          }
        }),
      );
    }
    return out;
  },
});

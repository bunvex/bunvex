// convex-helpers' `server/stream.property.test.ts` (e48f9df) ported to bunvex (STUDY-181 PR 3): properties of stream
// cursors over index keys that mix every value type (null, booleans, int64, numbers with -0, NaN and infinities,
// strings ending in "undefined", bytes, arrays, objects, and a missing field). With the same seeds, 1, 0xc0ffee and
// 0xdeadbeef (`CURSOR_TEST_SEED` / `CURSOR_TEST_CASES` reproduce or extend a run):
// - stale cursors stay scoped after deletes, re-indexing and tenant changes;
// - composed streams (filters, maps, merges, distinct, flatMaps) never read, return or reveal a key outside their
//   static bounds, whatever cursor they are given (fabricated, foreign, malformed), nor through the cursors they
//   give back;
// - valid pagination is complete and makes progress, and pages between endpoints match an oracle;
// - static index bounds, and ranges narrowed again and again, agree with a document oracle.
// A test oracle reads the documents a query reads (`observer`), so a read outside the bounds fails even when the
// page would hide it. These properties are about bounds, not secrecy: a cursor holds index values by design.
//
// Where it differs from upstream:
// - The random choices come from fast-check (`fc.gen()`, one run per seed, no bias), not upstream's hand-written
//   generator: the same seeds, the same draws in the same places, other values.
// - Upstream observes reads with convex-helpers' `wrapDatabaseReader` (row-level security, not ported yet); here a
//   reader of the test's own records each document a query yields.
// - Upstream runs each property in one convex-test mutation. A deployment refuses more than 4,096 query ranges or
//   32,000 documents read in one transaction (convex-test does not check), so each attack, page or case here is a
//   transaction of its own over the same data.
// - The known failing regression (filtered distinct resuming within an unfinished group) is `test.failing`, as
//   upstream's `test.fails`: the port keeps convex-helpers' behaviour, bug included.
// biome-ignore-all lint/suspicious/noExplicitAny: inline functions get `ctx` untyped, as upstream's tests use it
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { DataModelFromSchemaDefinition, DocumentByName, PaginationResult } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { compareValues, toJsonValue } from "@bunvex/values";
import fc from "fast-check";
import {
  type IndexBounds,
  type IndexKey,
  mergedStream,
  type QueryStream,
  stream,
  streamIndexRange,
} from "../../src/server/stream.ts";
import schema from "../fixtures/stream-property/bunvex/schema.ts";

const APP = join(import.meta.dir, "..", "fixtures", "stream-property");

const seeds = process.env.CURSOR_TEST_SEED ? [Number(process.env.CURSOR_TEST_SEED)] : [1, 0xc0ffee, 0xdeadbeef];
const cases = Number(process.env.CURSOR_TEST_CASES ?? 24);
if (!seeds.every(Number.isSafeInteger) || !Number.isSafeInteger(cases) || cases < 1)
  throw new Error("CURSOR_TEST_SEED and CURSOR_TEST_CASES must be integers; cases must be positive");

type Model = DataModelFromSchemaDefinition<typeof schema>;
type Row = DocumentByName<Model, "rows">;
type Group = DocumentByName<Model, "groups">;
type Order = "asc" | "desc";
type Entry = { doc: Row | null; key: IndexKey };
type Scenario = {
  name: string;
  query: QueryStream<Row>;
  entries: Entry[];
  readable: Set<string>;
  extraKeys?: IndexKey[];
  /** For distinct: pages end at a group's end, so the oracle compares key prefixes of this length. */
  distinctLength?: number;
  /** False for a scenario whose budgeted walk is a known failure (tested on its own). */
  budgetedWalk?: false;
};
type Cursor = { wire: string; key: IndexKey };
type Options = {
  cursor: string | null;
  numItems: number;
  endCursor?: string | null;
  maximumRowsRead?: number;
  maximumBytesRead?: number;
};

const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
const deployment = () => {
  const t = bunvexTest({ cwd: APP });
  open.push(t);
  return t;
};

/** Random choices, drawn from fast-check's generator for the run. */
type Rng = { int(n: number): number; pick<T>(items: readonly T[]): T; shuffle<T>(items: readonly T[]): T[] };
function rngOf(g: fc.GeneratorValue): Rng {
  const int = (n: number) => g((max: number) => fc.noBias(fc.nat({ max })), n - 1);
  return {
    int,
    pick: (items) => items[int(items.length)]!,
    shuffle(items) {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}
/** `body` once, with the random choices of `seed`. */
async function seeded(seed: number, body: (rng: Rng) => Promise<void>) {
  await fc.assert(
    fc.asyncProperty(fc.gen(), (g) => body(rngOf(g))),
    { seed, numRuns: 1, endOnFailure: true },
  );
}

const tenants: Row["tenant"][] = [
  undefined,
  null,
  false,
  true,
  -2n,
  2n,
  -Infinity,
  -1,
  -0,
  1,
  Infinity,
  NaN,
  "",
  "a",
  "m",
  "z",
  "undefined",
  "_undefined",
  "__undefined",
  new Uint8Array([0, 255]).buffer,
  [0, 1],
  { tag: 1 },
];

/**
 * A key as a cursor, encoded here and not with the library's own helpers, so a cursor the test makes up does not
 * share the library's mistakes: the value JSON of the key, `undefined` as "undefined", one "_" more before a string
 * ending in "undefined".
 */
function cursor(key: IndexKey): Cursor {
  const escaped = key.map((value) => {
    if (value === undefined) return "undefined";
    return typeof value === "string" && value.endsWith("undefined") ? `_${value}` : value;
  });
  return { key, wire: JSON.stringify(toJsonValue(escaped)) };
}
function keyOf(doc: Row | Group): IndexKey {
  return "score" in doc
    ? [doc.tenant, doc.bucket, doc.score, doc._creationTime, doc._id]
    : [doc.tenant, doc.bucket, doc._creationTime, doc._id];
}
/**
 * Plain lexicographic order, shorter first on a tie; independent of the library's bound positions, so the oracle
 * cannot repeat a boundary mistake of theirs.
 */
function compare(a: IndexKey, b: IndexKey): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareValues(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}
const sameTenant = (a: Row["tenant"], b: Row["tenant"]) => compareValues(a, b) === 0;
const ordered = (entries: Entry[], order: Order) =>
  entries.slice().sort((a, b) => compare(a.key, b.key) * (order === "asc" ? 1 : -1));
const entriesOf = (rows: Row[], order: Order): Entry[] =>
  ordered(
    rows.map((doc) => ({ doc, key: keyOf(doc) })),
    order,
  );
/** Whether a key is within bounds: its prefix compared to each bound, then the bound's inclusivity. */
function inBounds(key: IndexKey, bounds: IndexBounds): boolean {
  const lower = compare(key.slice(0, bounds.lowerBound.length), bounds.lowerBound);
  const upper = compare(key.slice(0, bounds.upperBound.length), bounds.upperBound);
  return (
    (lower > 0 || (lower === 0 && bounds.lowerBoundInclusive)) &&
    (upper < 0 || (upper === 0 && bounds.upperBoundInclusive))
  );
}
/** The page the oracle expects: the entries after `start` up to `end` (or the first `numItems`). */
function modelPage(scenario: Scenario, start: Cursor | null, end: Cursor | null, numItems: number): Row[] {
  const direction = scenario.query.getOrder() === "asc" ? 1 : -1;
  const project = (key: IndexKey) => key.slice(0, scenario.distinctLength ?? key.length);
  const relative = (key: IndexKey, to: Cursor) => {
    const bound = project(to.key);
    return compare(project(key).slice(0, bound.length), bound) * direction;
  };
  const docs = scenario.entries
    .filter(
      ({ key, doc }) =>
        doc !== null && (start === null || relative(key, start) > 0) && (end === null || relative(key, end) <= 0),
    )
    .map(({ doc }) => doc!);
  return end === null ? docs.slice(0, numItems) : docs;
}

/** A deployment with every tenant's groups (3 buckets) and rows (4 scores each), the rows inserted shuffled. */
async function fixture(rng: Rng, selectedTenants = tenants) {
  const t = deployment();
  let rows: Row[] = [];
  let groups: Group[] = [];
  await t.run(async (ctx: any) => {
    const input: Omit<Row, "_id" | "_creationTime">[] = [];
    for (const tenant of selectedTenants)
      for (let bucket = 0; bucket < 3; bucket++) {
        await ctx.db.insert("groups", { tenant, bucket });
        for (const score of [-1, 0, 1, rng.int(5) - 2])
          input.push({ tenant, nested: { tenant }, bucket, score, secret: `secret-${input.length}` });
      }
    for (const row of rng.shuffle(input)) await ctx.db.insert("rows", row);
    rows = await ctx.db.query("rows").collect();
    groups = await ctx.db.query("groups").collect();
  });
  return { t, rows, groups };
}

/** A reader that records the id of every document its queries yield, and lets each through. */
function observer(db: any) {
  const reads: string[] = [];
  const BUILDERS = new Set(["withIndex", "order", "fullTableScan", "filter"]);
  const observed = (query: any): any =>
    new Proxy(query, {
      get(target, prop) {
        if (prop === Symbol.asyncIterator)
          return () => {
            const docs = target[Symbol.asyncIterator]();
            return {
              async next() {
                const result = await docs.next();
                if (!result.done) reads.push(result.value._id);
                return result;
              },
            };
          };
        const value = target[prop];
        if (typeof value !== "function") return value;
        return BUILDERS.has(prop as string)
          ? (...args: unknown[]) => observed(value.apply(target, args))
          : value.bind(target);
      },
    });
  const reader = {
    system: db.system,
    query: (table: string) => observed(db.query(table)),
    get: (...args: unknown[]) => db.get(...args),
    normalizeId: (...args: unknown[]) => db.normalizeId(...args),
  };
  return { db: reader, reads };
}

/**
 * A page of the scenario, checked: no document read outside its readable set (checked even when the call throws),
 * only its visible documents returned, and only its own keys (or the caller's) as cursors. With `allowError`, a
 * throw is an acceptable outcome (`undefined`).
 */
async function check(
  scenario: Scenario,
  reads: string[],
  opts: Options,
  label: string,
  allowError = false,
): Promise<PaginationResult<Row> | undefined> {
  reads.length = 0;
  let result: PaginationResult<Row> | undefined;
  let failure: unknown;
  try {
    result = await scenario.query.paginate(opts as any);
  } catch (error) {
    failure = error;
  }
  const context = `${label}; ${scenario.name}; ${JSON.stringify(opts)}`;
  expect({ context, outOfRange: reads.filter((id) => !scenario.readable.has(id)) }).toEqual({
    context,
    outOfRange: [],
  });
  if (failure !== undefined) {
    if (!allowError) throw new Error(context, { cause: failure });
    return undefined;
  }
  const visible = new Set(scenario.entries.flatMap((entry) => (entry.doc ? [entry.doc._id] : [])));
  expect({ context, hidden: result!.page.filter((doc) => !visible.has(doc._id)) }).toEqual({ context, hidden: [] });
  const ownKeys = new Set(
    [...scenario.entries.map((e) => e.key), ...(scenario.extraKeys ?? [])].map((k) => cursor(k).wire),
  );
  for (const output of [result!.continueCursor, result!.splitCursor]) {
    // Giving back the caller's own endpoint reveals nothing of the server's.
    if (
      output === undefined ||
      output === null ||
      output === "[]" ||
      output === opts.endCursor ||
      (opts.numItems === 0 && output === opts.cursor)
    )
      continue;
    expect({ context, output, own: ownKeys.has(output) }).toEqual({ context, output, own: true });
  }
  return result;
}

/** Cursors near real keys: every prefix, each value swapped for another, spliced keys, and keys made longer. */
function mutations(keys: IndexKey[], rng: Rng): Cursor[] {
  const out: IndexKey[] = [[], ...tenants.map((tenant) => [tenant])];
  for (const key of keys.slice(0, 6)) {
    for (let length = 0; length <= key.length; length++) out.push(key.slice(0, length));
    for (let at = 0; at < key.length; at++) {
      for (const value of [undefined, null, "undefined", rng.pick(tenants)]) {
        const edited = key.slice();
        edited[at] = value;
        out.push(edited);
      }
      out.push([...key.slice(0, at), ...rng.pick(keys).slice(at)]);
    }
    out.push([...key, null], [...key, ...rng.pick(keys)]);
  }
  const unique = new Map<string, Cursor>();
  for (const key of out) {
    const c = cursor(key);
    unique.set(c.wire, c);
  }
  return [...unique.values()];
}

const ROW_FIELDS = ["tenant", "bucket", "score", "_creationTime", "_id"];

/** The composed streams under test, each with what it may read and return, on the rows of tenant "m" (or a, z). */
function scenarios(db: any, rows: Row[], groups: Group[], order: Order): Scenario[] {
  const streams = stream(db, schema);
  const owned = rows.filter((row) => row.tenant === "m");
  const ownGroups = groups.filter((group) => group.tenant === "m");
  const base = streams
    .query("rows")
    .withIndex("tenant_bucket_score", (q) => q.eq("tenant", "m"))
    .order(order);
  const outer = streams
    .query("groups")
    .withIndex("tenant_bucket", (q) => q.eq("tenant", "m"))
    .order(order);
  const make = (
    name: string,
    query: QueryStream<Row>,
    allowed: Row[],
    entries = entriesOf(allowed, order),
    outerReads: Group[] = [],
    extraKeys: IndexKey[] = [],
  ): Scenario => ({
    name,
    query,
    entries: ordered(entries, order),
    extraKeys,
    readable: new Set([...allowed, ...outerReads].map((doc) => doc._id)),
  });
  const baseEntries = entriesOf(owned, order);
  const keepIf = (keep: (doc: Row) => boolean) => (entry: Entry) => ({
    ...entry,
    doc: keep(entry.doc!) ? entry.doc : null,
  });
  const nulls = (n: number) => Array(n).fill(null);
  const result: Scenario[] = [
    make("plain", base, owned),
    make(
      "bounded",
      streams
        .query("rows")
        .withIndex("tenant_bucket_score", (q) => q.eq("tenant", "m").eq("bucket", 1).gte("score", 0))
        .order(order),
      owned.filter((row) => row.bucket === 1 && row.score >= 0),
    ),
    make(
      "nested index field",
      streams
        .query("rows")
        .withIndex("nested_tenant", (q) => q.eq("nested.tenant", "m"))
        .order(order),
      owned,
    ),
    make(
      "different index",
      streams
        .query("rows")
        .withIndex("tenant_score", (q) => q.eq("tenant", "m"))
        .order(order),
      owned,
      owned.map((doc) => ({ doc, key: [doc.tenant, doc.score, doc._creationTime, doc._id] })),
    ),
    make(
      "map changes indexed fields",
      base.map(async (doc) => ({ ...doc, tenant: "redacted", bucket: -100, score: -100 })),
      owned,
    ),
    make(
      "filter",
      base.filterWith(async (doc) => doc.score > 0),
      owned,
      baseEntries.map(keepIf((doc) => doc.score > 0)),
    ),
    make(
      "filter all",
      base.filterWith(async () => false),
      owned,
      baseEntries.map((entry) => ({ ...entry, doc: null })),
    ),
    make(
      "filter and map",
      base.filterWith(async (doc) => doc.score > 0).map(async (doc) => ({ ...doc, bucket: -100 })),
      owned,
      baseEntries.map(keepIf((doc) => doc.score > 0)),
    ),
  ];
  const first = rows[3]!;
  const last = rows[rows.length - 4]!;
  const byTime = rows.filter(
    (row) => row._creationTime >= first._creationTime && row._creationTime < last._creationTime,
  );
  result.push(
    make(
      "creation time",
      streams
        .query("rows")
        .withIndex("by_creation_time", (q) =>
          q.gte("_creationTime", first._creationTime).lt("_creationTime", last._creationTime),
        )
        .order(order),
      byTime,
      byTime.map((doc) => ({ doc, key: [doc._creationTime, doc._id] })),
    ),
    make(
      "document id",
      streams
        .query("rows")
        .withIndex("by_id", (q) => q.eq("_id", first._id))
        .order(order),
      [first],
      [{ doc: first, key: [first._id] }],
    ),
  );
  const unionRows = rows.filter((row) => row.tenant === "a" || row.tenant === "z");
  result.push(
    make(
      "merge across an unauthorized tenant",
      mergedStream(
        ["a", "z"].map((tenant) =>
          streams
            .query("rows")
            .withIndex("tenant_bucket_score", (q) => q.eq("tenant", tenant))
            .order(order),
        ),
        ["bucket", "score"],
      ),
      unionRows,
      unionRows.map((doc) => ({ doc, key: keyOf(doc).slice(1) })),
    ),
  );
  const disjoint = owned.filter((row) => row.bucket === 0 || row.bucket === 2);
  result.push(
    make(
      "merge disjoint ranges",
      mergedStream(
        [0, 2].map((bucket) =>
          streams
            .query("rows")
            .withIndex("tenant_bucket_score", (q) => q.eq("tenant", "m").eq("bucket", bucket))
            .order(order),
        ),
        ["bucket", "score"],
      ),
      disjoint,
      disjoint.map((doc) => ({ doc, key: keyOf(doc).slice(1) })),
    ),
  );
  const distinctEntries = baseEntries.filter(
    (entry, i) => i === 0 || entry.doc!.bucket !== baseEntries[i - 1]!.doc!.bucket,
  );
  result.push(
    { ...make("distinct", base.distinct(["bucket"]), owned, distinctEntries), distinctLength: 2 },
    {
      ...make(
        "distinct then filter",
        base.distinct(["bucket"]).filterWith(async (doc) => doc.bucket !== 1),
        owned,
        distinctEntries.map(keepIf((doc) => doc.bucket !== 1)),
      ),
      distinctLength: 2,
    },
  );
  // Filtered before distinct: a group is settled by its first kept row; the rows before it are read and left out.
  const filteredDistinct: Entry[] = [];
  const settled = new Set<number>();
  for (const entry of baseEntries) {
    const doc = entry.doc!;
    if (settled.has(doc.bucket)) continue;
    if (doc.score === 0) settled.add(doc.bucket);
    filteredDistinct.push({ ...entry, doc: doc.score === 0 ? doc : null });
  }
  result.push({
    ...make(
      "filter then distinct",
      base.filterWith(async (doc) => doc.score === 0).distinct(["bucket"]),
      owned,
      filteredDistinct,
    ),
    distinctLength: 2,
    budgetedWalk: false,
  });

  const positive = owned.filter((row) => row.score >= 0);
  const positiveOf = (group: Group) =>
    streams
      .query("rows")
      .withIndex("tenant_bucket_score", (q) => q.eq("tenant", group.tenant).eq("bucket", group.bucket).gte("score", 0))
      .order(order);
  result.push(
    make(
      "flatMap",
      outer.flatMap(async (group) => positiveOf(group), [...ROW_FIELDS]),
      positive,
      ownGroups.flatMap((group) =>
        positive
          .filter((doc) => doc.bucket === group.bucket)
          .map((doc) => ({ doc, key: [...keyOf(group), ...keyOf(doc)] })),
      ),
      ownGroups,
      ownGroups.map((group) => [...keyOf(group), ...nulls(5)]),
    ),
  );
  const nonzero = owned.filter((row) => row.score !== 0);
  const filteredInner = positive.filter((row) => row.bucket === 1);
  result.push(
    make(
      "filtered outer flatMap",
      outer
        .filterWith(async (group) => group.bucket === 1)
        .flatMap(async (group) => positiveOf(group), [...ROW_FIELDS]),
      filteredInner,
      ownGroups
        .filter((group) => group.bucket === 1)
        .flatMap((group) => filteredInner.map((doc) => ({ doc, key: [...keyOf(group), ...keyOf(doc)] }))),
      ownGroups,
      ownGroups.map((group) => [...keyOf(group), ...nulls(5)]),
    ),
    make(
      "flatMap merged inner",
      outer.flatMap(
        async (group) =>
          mergedStream(
            [
              streams
                .query("rows")
                .withIndex("tenant_bucket_score", (q) =>
                  q.eq("tenant", group.tenant).eq("bucket", group.bucket).lt("score", 0),
                )
                .order(order),
              streams
                .query("rows")
                .withIndex("tenant_bucket_score", (q) =>
                  q.eq("tenant", group.tenant).eq("bucket", group.bucket).gt("score", 0),
                )
                .order(order),
            ],
            ["score"],
          ),
        ["score", "_creationTime", "_id"],
      ),
      nonzero,
      ownGroups.flatMap((group) =>
        nonzero
          .filter((doc) => doc.bucket === group.bucket)
          .map((doc) => ({ doc, key: [...keyOf(group), ...keyOf(doc).slice(2)] })),
      ),
      ownGroups,
      ownGroups.map((group) => [...keyOf(group), ...nulls(3)]),
    ),
  );
  const unionGroups = groups.filter((group) => group.tenant === "a" || group.tenant === "z");
  const mergedOuter = mergedStream(
    ["a", "z"].map((tenant) =>
      streams
        .query("groups")
        .withIndex("tenant_bucket", (q) => q.eq("tenant", tenant))
        .order(order),
    ),
    ["bucket"],
  );
  result.push(
    make(
      "merged outer flatMap",
      mergedOuter.flatMap(
        async (group) =>
          streams
            .query("rows")
            .withIndex("tenant_bucket_score", (q) => q.eq("tenant", group.tenant).eq("bucket", group.bucket))
            .order(order),
        [...ROW_FIELDS],
      ),
      unionRows,
      unionGroups.flatMap((group) =>
        unionRows
          .filter((doc) => doc.tenant === group.tenant && doc.bucket === group.bucket)
          .map((doc) => ({ doc, key: [...keyOf(group).slice(1), ...keyOf(doc)] })),
      ),
      unionGroups,
      unionGroups.map((group) => [...keyOf(group).slice(1), ...nulls(5)]),
    ),
    make(
      "nested flatMap",
      outer.flatMap(
        async (group) =>
          streams
            .query("rows")
            .withIndex("tenant_bucket_score", (q) => q.eq("tenant", group.tenant).eq("bucket", group.bucket))
            .order(order)
            .flatMap(
              async (middle) =>
                streams
                  .query("rows")
                  .withIndex("tenant_bucket_score", (q) =>
                    q.eq("tenant", middle.tenant).eq("bucket", middle.bucket).eq("score", middle.score),
                  )
                  .order(order),
              [...ROW_FIELDS],
            ),
        [...ROW_FIELDS, ...ROW_FIELDS],
      ),
      owned,
      ownGroups.flatMap((group) =>
        owned
          .filter((middle) => middle.bucket === group.bucket)
          .flatMap((middle) =>
            owned
              .filter((doc) => doc.bucket === middle.bucket && doc.score === middle.score)
              .map((doc) => ({ doc, key: [...keyOf(group), ...keyOf(middle), ...keyOf(doc)] })),
          ),
      ),
      ownGroups,
      ownGroups.flatMap((group) => [
        [...keyOf(group), ...nulls(10)],
        ...owned
          .filter((middle) => middle.bucket === group.bucket)
          .map((middle) => [...keyOf(group), ...keyOf(middle), ...nulls(5)]),
      ]),
    ),
  );
  return result;
}

const malformed = [
  "",
  " ",
  "[",
  "null",
  "false",
  "1",
  '"[]"',
  "{}",
  '{"0":"m","length":1}',
  '[{"$integer":"bad"}]',
  '[{"$float":"bad"}]',
  '[{"$undefined":true}]',
  '[{"$bytes":"!"}]',
  '[{"__proto__":{"tenant":"z"}}]',
  '["\\u0075ndefined"]',
];

/** For the scenarios' expectations alone: building a stream reads nothing until it is iterated. */
const NO_DATABASE = {};

/** One scenario (by position) in a transaction of its own, read through an observer. */
function inScenario(t: TestBunvex, rows: Row[], groups: Group[], order: Order, index: number) {
  return (body: (scenario: Scenario, reads: string[]) => Promise<void>) =>
    t.run(async (ctx: any) => {
      const { db, reads } = observer(ctx.db);
      await body(scenarios(db, rows, groups, order)[index]!, reads);
    });
}

// An empty inner stream yields a placeholder whose inner key is all nulls; a page that a budget stops on it must
// resume past it.
for (const { order, ...limit } of [
  { order: "asc", maximumRowsRead: 1 },
  { order: "desc", maximumRowsRead: 1 },
  { order: "asc", maximumBytesRead: 1 },
  { order: "desc", maximumBytesRead: 1 },
] as const) {
  test(`flatMap advances past a budgeted empty inner stream: ${JSON.stringify({ order, ...limit })}`, async () => {
    const t = deployment();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("groups", { tenant: "m", bucket: 0 });
      const db = stream(ctx.db, schema);
      const query = db
        .query("groups")
        .withIndex("tenant_bucket", (q) => q.eq("tenant", "m"))
        .order(order)
        .flatMap(
          async (group) =>
            db
              .query("rows")
              .withIndex("tenant_bucket_score", (q) => q.eq("tenant", group.tenant))
              .order(order),
          [...ROW_FIELDS],
        );
      const first = await query.paginate({ cursor: null, numItems: 1, ...limit });
      expect(first.page).toEqual([]);
      const second = await query.paginate({ cursor: first.continueCursor, numItems: 1, ...limit });
      expect(second.isDone).toBe(true);
    });
  });
}

test.each(["asc", "desc"] as const)(
  "a skipped inner cursor preserves its position after inserts (%s)",
  async (order) => {
    const t = deployment();
    await t.run(async (ctx: any) => {
      await ctx.db.insert("groups", { tenant: "m", bucket: 0 });
      const db = stream(ctx.db, schema);
      const query = db
        .query("groups")
        .withIndex("tenant_bucket", (q) => q.eq("tenant", "m"))
        .order(order)
        .flatMap(
          async (group) =>
            db
              .query("rows")
              .withIndex("tenant_bucket_score", (q) =>
                q.eq("tenant", group.tenant).eq("bucket", group.bucket).gte("score", 0),
              )
              .order(order),
          [...ROW_FIELDS],
        );
      const first = await query.paginate({ cursor: null, numItems: 1, maximumRowsRead: 1 });
      expect(first.page).toEqual([]);
      expect(first.isDone).toBe(false);
      // Rows inserted now fall on either side of the placeholder's position; adjacent pages hold each exactly once.
      const row = (tenant: string, bucket: number, score: number, secret: string) => ({
        tenant,
        nested: { tenant },
        bucket,
        score,
        secret,
      });
      const inserted = await ctx.db.insert("rows", row("m", 0, 1, "new allowed row"));
      await ctx.db.insert("rows", row("z", 0, 1, "foreign row"));
      await ctx.db.insert("rows", row("m", 0, -1, "excluded row"));
      const nextBucket = order === "asc" ? 1 : -1;
      await ctx.db.insert("groups", { tenant: "m", bucket: nextBucket });
      const later = await ctx.db.insert("rows", row("m", nextBucket, 1, "next outer row"));
      const resumed = await query.paginate({ cursor: first.continueCursor, numItems: 10 });
      expect(resumed.page.map((doc) => doc._id)).toEqual(order === "asc" ? [inserted, later] : [later]);
      const refreshed = await query.paginate({ cursor: null, endCursor: first.continueCursor, numItems: 10 });
      expect(refreshed.page.map((doc) => doc._id)).toEqual(order === "asc" ? [] : [inserted]);
    });
  },
);

// Known failure, kept from convex-helpers 0.1.128: a distinct after a filter cuts a continuation to the group's
// prefix even when the budget stopped on a row left out before any of the group was returned, which skips the
// group's later matching row in either direction. It fails upstream too (`test.fails`); the port keeps the behaviour.
for (const { order, ...limit } of [
  { order: "asc", maximumRowsRead: 1 },
  { order: "desc", maximumRowsRead: 1 },
  { order: "asc", maximumBytesRead: 1 },
  { order: "desc", maximumBytesRead: 1 },
] as const) {
  test.failing(`filtered distinct resumes within an unfinished group: ${JSON.stringify({ order, ...limit })}`, async () => {
    const t = deployment();
    await t.run(async (ctx: any) => {
      for (const score of [-1, 0, 1])
        await ctx.db.insert("rows", {
          tenant: "m",
          nested: { tenant: "m" },
          bucket: 0,
          score,
          secret: `secret-${score}`,
        });
      const query = stream(ctx.db, schema)
        .query("rows")
        .withIndex("tenant_bucket_score", (q) => q.eq("tenant", "m"))
        .order(order)
        .filterWith(async (row) => row.score === 0)
        .distinct(["bucket"]);
      const unlimited = await query.paginate({ cursor: null, numItems: 1 });
      expect(unlimited.page.map((row) => row.score)).toEqual([0]);
      const first = await query.paginate({ cursor: null, numItems: 1, ...limit });
      expect(first.page).toEqual([]);
      const second = await query.paginate({ cursor: first.continueCursor, numItems: 1, ...limit });
      expect(second.page).toEqual(unlimited.page);
    });
  });
}

describe.each(seeds)("stream cursor properties (seed %i)", (seed) => {
  test.each(["asc", "desc"] as const)(
    "stale cursors remain scoped after deletion, reindexing, and tenant changes (%s)",
    (order) =>
      seeded(seed, async (rng) => {
        const { t, rows } = await fixture(rng, ["a", "m", "z"]);
        const issued: string[] = [];
        await t.run(async (ctx: any) => {
          const query = stream(ctx.db, schema)
            .query("rows")
            .withIndex("tenant_bucket_score", (q) => q.eq("tenant", "m"))
            .order(order);
          let next: string | null = null;
          for (let i = 0; i < 5; i++) {
            next = (await query.paginate({ cursor: next, numItems: 1 })).continueCursor;
            issued.push(next);
          }
        });
        const owned = rng.shuffle(rows.filter((row) => row.tenant === "m"));
        await t.run(async (ctx: any) => {
          await ctx.db.delete("rows", owned[0]!._id);
          await ctx.db.patch("rows", owned[1]!._id, { tenant: "z", nested: { tenant: "z" } });
          await ctx.db.patch("rows", owned[2]!._id, { bucket: 9, score: 100 });
          await ctx.db.insert("rows", {
            tenant: "a",
            nested: { tenant: "a" },
            bucket: 0,
            score: 0,
            secret: "new foreign secret",
          });
        });
        await t.run(async (ctx: any) => {
          const current: Row[] = await ctx.db.query("rows").collect();
          const { db, reads } = observer(ctx.db);
          // The cursors issued for "m", replayed under "m" and under another tenant.
          for (const tenant of ["m", "a"]) {
            const allowed = current.filter((row) => row.tenant === tenant && row.bucket < 3);
            const scenario: Scenario = {
              name: `stale ${tenant}`,
              query: stream(db, schema)
                .query("rows")
                .withIndex("tenant_bucket_score", (q) => q.eq("tenant", tenant).lt("bucket", 3))
                .order(order),
              entries: entriesOf(allowed, order),
              readable: new Set(allowed.map((row) => row._id)),
            };
            for (const wire of issued)
              for (const opts of [
                { cursor: wire, numItems: 100 },
                { cursor: null, endCursor: wire, numItems: 100 },
              ])
                await check(scenario, reads, opts, `seed ${seed}, stale`);
          }
        });
      }),
  );

  test.each(["asc", "desc"] as const)(
    "composed streams preserve scope under adversarial cursors (%s)",
    (order) =>
      seeded(seed, async (rng) => {
        const { t, rows, groups } = await fixture(rng, ["a", "m", "z"]);
        // The scenarios' expectations need no database; each attack runs them in a transaction of its own.
        const variants = scenarios(NO_DATABASE, rows, groups, order);
        // Keys of other tenants, tables, indexes and compositions.
        const crossQuery = [
          ...groups.map(keyOf),
          ...variants.flatMap((s) =>
            s.entries
              .filter((entry) => entry.doc)
              .slice(0, 2)
              .map((entry) => entry.key),
          ),
        ];
        for (const [index, variant] of variants.entries()) {
          const ownKeys = variant.entries.map((entry) => entry.key);
          const attacks = [
            ...mutations([...rng.shuffle(ownKeys).slice(0, 3), ...rng.shuffle(rows).slice(0, 3).map(keyOf)], rng).map(
              (c) => c.wire,
            ),
            ...crossQuery.map((key) => cursor(key).wire),
            ...malformed,
          ];
          for (const [i, wire] of attacks.entries()) {
            const other = rng.pick(attacks);
            const options: Options[] = [
              { cursor: wire, numItems: rng.pick([0, 1, 2, 100, -1, 0.5]) },
              { cursor: null, endCursor: wire, numItems: 1 },
              { cursor: wire, endCursor: other, numItems: 3, maximumRowsRead: rng.pick([0, 1, 3]) },
              { cursor: other, endCursor: wire, numItems: 3, maximumBytesRead: rng.pick([0, 1, 500]) },
            ];
            await inScenario(
              t,
              rows,
              groups,
              order,
              index,
            )(async (scenario, reads) => {
              for (const opts of options) {
                const result = await check(scenario, reads, opts, `seed ${seed}, attack ${i}`, true);
                if (!result) continue;
                // A cursor that leaks could open a second request even after an empty page: replay both outputs.
                const outputs = new Set(
                  [result.continueCursor, result.splitCursor].filter((c): c is string => typeof c === "string"),
                );
                for (const next of outputs) {
                  await check(
                    scenario,
                    reads,
                    { cursor: next, numItems: 2, maximumRowsRead: 2 },
                    `seed ${seed}, replay ${i}`,
                    true,
                  );
                  await check(
                    scenario,
                    reads,
                    { cursor: null, endCursor: next, numItems: 2, maximumRowsRead: 2 },
                    `seed ${seed}, replay end ${i}`,
                    true,
                  );
                }
              }
            });
          }
        }
      }),
    120_000,
  );

  test.each(["asc", "desc"] as const)(
    "valid composed pagination is complete and makes progress (%s)",
    (order) =>
      seeded(seed, async (rng) => {
        const { t, rows, groups } = await fixture(rng, ["a", "m", "z"]);
        const variants = scenarios(NO_DATABASE, rows, groups, order);
        for (const [index, variant] of variants.entries()) {
          const inThis = inScenario(t, rows, groups, order, index);
          const expected = variant.entries.flatMap((entry) => (entry.doc ? [entry.doc._id] : []));
          const actual: string[] = [];
          let next: string | null = null;
          let done = false;
          const seen = new Set<string>();
          for (let page = 0; page < variant.entries.length * 3 + groups.length * 3 + 10; page++) {
            const opts: Options = {
              cursor: next,
              numItems: rng.int(3) + 1,
              // Budgeted walks known to fail are tested on their own; the adversarial test still budgets every one.
              maximumRowsRead: variant.budgetedWalk === false ? undefined : rng.pick([undefined, 1, 3]),
              maximumBytesRead: variant.budgetedWalk === false ? undefined : rng.pick([undefined, 1, 500]),
            };
            let result: PaginationResult<Row> | undefined;
            await inThis(async (scenario, reads) => {
              result = await check(scenario, reads, opts, `seed ${seed}, page ${page}`);
            });
            actual.push(...result!.page.map((row) => row._id));
            if (result!.isDone) {
              done = true;
              break;
            }
            expect({ name: variant.name, advanced: !seen.has(result!.continueCursor) }).toEqual({
              name: variant.name,
              advanced: true,
            });
            seen.add(result!.continueCursor);
            next = result!.continueCursor;
          }
          expect({ name: variant.name, done, actual }).toEqual({ name: variant.name, done: true, actual: expected });
          const endpoints: (Cursor | null)[] = [
            null,
            cursor([]),
            ...rng
              .shuffle(variant.entries)
              .slice(0, 6)
              .map((entry) => cursor(entry.key)),
          ];
          for (const start of endpoints)
            await inThis(async (scenario, reads) => {
              for (const end of endpoints) {
                const opts = { cursor: start?.wire ?? null, endCursor: end?.wire, numItems: 3 };
                const result = await check(scenario, reads, opts, `seed ${seed}, endpoints`);
                expect({ name: scenario.name, opts, page: result!.page.map((row) => row._id) }).toEqual({
                  name: scenario.name,
                  opts,
                  page: modelPage(scenario, start, end, 3).map((row) => row._id),
                });
              }
            });
        }
      }),
    120_000,
  );

  test.each(["asc", "desc"] as const)(
    "static index bounds agree with a document oracle (%s)",
    (order) =>
      seeded(seed, async (rng) => {
        const { t, rows } = await fixture(rng);
        for (let i = 0; i < Math.max(cases, tenants.length); i++) {
          const tenant = tenants[i % tenants.length];
          const bucket = rng.int(3);
          const lower = rng.int(5) - 2;
          const upper = rng.int(5) - 1;
          const lowerInclusive = rng.int(2) === 0;
          const upperInclusive = rng.int(2) === 0;
          const depth = i % 3;
          const allowed = rows.filter((row) => {
            if (!sameTenant(row.tenant, tenant)) return false;
            if (depth === 2) return row.bucket === bucket && row.score === lower;
            if (depth === 1 && row.bucket !== bucket) return false;
            const value = depth === 1 ? row.score : row.bucket;
            return (
              (lowerInclusive ? value >= lower : value > lower) && (upperInclusive ? value <= upper : value < upper)
            );
          });
          const candidates = [
            cursor([]),
            ...rng
              .shuffle(rows)
              .slice(0, 5)
              .flatMap((row) => {
                const key = keyOf(row);
                return [cursor(key), cursor(key.slice(0, rng.int(key.length + 1)))];
              }),
          ];
          const endpoints: (Cursor | null)[] = [null, ...candidates];
          const calls: { start: Cursor | null; end: Cursor | null; numItems: number }[] = [];
          for (const start of endpoints)
            for (const end of [null, rng.pick(endpoints)]) calls.push({ start, end, numItems: rng.pick([1, 2, 100]) });
          await t.run(async (ctx: any) => {
            const { db, reads } = observer(ctx.db);
            const query = stream(db, schema)
              .query("rows")
              .withIndex("tenant_bucket_score", (q) => {
                const fixed = q.eq("tenant", tenant);
                if (depth === 2) return fixed.eq("bucket", bucket).eq("score", lower);
                if (depth === 1) {
                  const inBucket = fixed.eq("bucket", bucket);
                  const from = lowerInclusive ? inBucket.gte("score", lower) : inBucket.gt("score", lower);
                  return upperInclusive ? from.lte("score", upper) : from.lt("score", upper);
                }
                const from = lowerInclusive ? fixed.gte("bucket", lower) : fixed.gt("bucket", lower);
                return upperInclusive ? from.lte("bucket", upper) : from.lt("bucket", upper);
              })
              .order(order);
            const scenario: Scenario = {
              name: `static case ${i}, depth ${depth}`,
              query,
              entries: entriesOf(allowed, order),
              readable: new Set(allowed.map((row) => row._id)),
            };
            for (const { start, end, numItems } of calls) {
              const opts = { cursor: start?.wire ?? null, endCursor: end?.wire, numItems };
              const result = await check(scenario, reads, opts, `seed ${seed}`);
              expect({ name: scenario.name, opts, page: result!.page.map((row) => row._id) }).toEqual({
                name: scenario.name,
                opts,
                page: modelPage(scenario, start, end, numItems).map((row) => row._id),
              });
            }
          });
        }
      }),
    60_000,
  );

  test.each(["asc", "desc"] as const)(
    "lexicographic and repeatedly narrowed ranges never expand (%s)",
    (order) =>
      seeded(seed, async (rng) => {
        const { t, rows } = await fixture(rng, ["a", "m", "z"]);
        const bound = () => {
          const key = keyOf(rng.pick(rows));
          return key.slice(0, rng.int(key.length + 1));
        };
        for (let i = 0; i < cases; i++) {
          const bounds: IndexBounds = {
            lowerBound: bound(),
            upperBound: bound(),
            lowerBoundInclusive: rng.int(2) === 0,
            upperBoundInclusive: rng.int(2) === 0,
          };
          // Each round narrows to new bounds, drawn here as upstream draws them after each round.
          const narrowings: IndexBounds[] = [];
          for (let round = 0; round < 3; round++)
            narrowings.push({ ...bounds, lowerBound: bound(), upperBound: bound() });
          await t.run(async (ctx: any) => {
            const { db, reads } = observer(ctx.db);
            const allowed = rows.filter((row) => inBounds(keyOf(row), bounds));
            let scenario: Scenario = {
              name: `range ${i}`,
              query: streamIndexRange(db, schema, "rows", "tenant_bucket_score", bounds, order),
              entries: entriesOf(allowed, order),
              readable: new Set(allowed.map((row) => row._id)),
            };
            for (const [round, next] of narrowings.entries()) {
              const result = await check(
                scenario,
                reads,
                { cursor: null, numItems: 1000 },
                `seed ${seed}, round ${round}`,
              );
              expect({ name: scenario.name, round, page: result!.page.map((row) => row._id) }).toEqual({
                name: scenario.name,
                round,
                page: scenario.entries.map((entry) => entry.doc!._id),
              });
              const entries = scenario.entries.filter((entry) => inBounds(entry.key, next));
              scenario = {
                ...scenario,
                query: scenario.query.narrow(next),
                entries,
                readable: new Set(entries.map((entry) => entry.doc!._id)),
              };
            }
          });
        }
      }),
    60_000,
  );
});

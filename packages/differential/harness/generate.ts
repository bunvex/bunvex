// Generated programs (STUDY-122 §3.1, phase 2): writes and reads inside one mutation (the #410 class), then
// queries and pagination. Written from scratch with fast-check. Values that index ranges compare come from
// small pools, so ranges, filters and `unique` meet real documents, ties and mixed types; the other fields
// take values of every kind the JSON format carries. A document is named by its position among the inserts
// generated so far, so a failing program shrinks to a small one.
import fc from "fast-check";
import type { ActionStep, Call, Program, ProgramOp } from "./runner.ts";

type Value = null | boolean | number | string | Value[] | { [k: string]: Value };
const UNDEFINED = { $undefined: true } as const;

/** The cases of the app's `limit` op compared on both backends: all of them (case 8, a lone surrogate, STUDY-135). */
export const LIMIT_CASES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Values an index or a filter compares: a few of each type, so they meet. */
const keyValue = fc.constantFrom<Value>("a", "b", "c", "", 1, 2, -1, 0.5, null, true);
const smallInt = fc.integer({ min: 0, max: 3 });

/** Any value the JSON format carries, nested up to `depth`. */
const anyValue: fc.Arbitrary<Value> = fc.letrec<{ v: Value }>((tie) => ({
  v: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e12, max: 1e12 }),
    fc.string({ maxLength: 6 }),
    fc.constantFrom("é", "😀", "ﬀ", "a\u0000b", " ", "Z"),
    fc.array(tie("v"), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom("x", "y", "z"), tie("v"), { maxKeys: 3 }),
  ),
})).v;

/** A document of table `a` (fields `k`, `n` are indexed) or `b` (`x` is indexed); any field may be absent. */
const docA = fc.record(
  { k: keyValue, n: fc.oneof(smallInt, keyValue), extra: anyValue },
  { requiredKeys: [] },
) as fc.Arbitrary<Record<string, unknown>>;
const docB = fc.record({ x: fc.oneof(smallInt, keyValue), extra: anyValue }, { requiredKeys: [] }) as fc.Arbitrary<
  Record<string, unknown>
>;

/** Fields a patch writes: a new value, or `undefined` (the field removed). */
const patchFields = fc.dictionary(
  fc.constantFrom("k", "n", "x", "extra", "added"),
  fc.oneof(keyValue, smallInt, anyValue, fc.constant(UNDEFINED as unknown as Value)),
  { minKeys: 1, maxKeys: 3 },
) as fc.Arbitrary<Record<string, unknown>>;

type Bound = { field: string; op: "eq" | "gt" | "gte" | "lt" | "lte"; value: unknown };

/** A range on `fields` (an index's): equalities on a prefix, then at most a lower and an upper bound. */
function rangeOn(fields: string[], valuesFor: (f: string) => fc.Arbitrary<Value>): fc.Arbitrary<Bound[]> {
  return fc.integer({ min: 0, max: fields.length }).chain((eqs) => {
    const eqBounds = fc.tuple(
      ...fields.slice(0, eqs).map((f) => valuesFor(f).map((value) => ({ field: f, op: "eq" as const, value }))),
    );
    const next = fields[eqs];
    if (next === undefined) return eqBounds.map((b) => [...b] as Bound[]);
    const lower = fc.option(fc.tuple(fc.constantFrom("gt" as const, "gte" as const), valuesFor(next)), {
      nil: undefined,
    });
    const upper = fc.option(fc.tuple(fc.constantFrom("lt" as const, "lte" as const), valuesFor(next)), {
      nil: undefined,
    });
    return fc
      .tuple(eqBounds, lower, upper)
      .map(([b, lo, hi]) => [
        ...b,
        ...(lo ? [{ field: next, op: lo[0], value: lo[1] }] : []),
        ...(hi ? [{ field: next, op: hi[0], value: hi[1] }] : []),
      ]);
  });
}

const indexedValue = (f: string): fc.Arbitrary<Value> => (f === "k" ? keyValue : fc.oneof(smallInt, keyValue));

/** A range Convex refuses (a field out of order, or twice): the error must be the same. */
const badRange = fc.constantFrom<Bound[]>(
  [{ field: "n", op: "eq", value: 1 }],
  [
    { field: "k", op: "gt", value: "a" },
    { field: "n", op: "eq", value: 1 },
  ],
  [
    { field: "k", op: "eq", value: "a" },
    { field: "k", op: "eq", value: "b" },
  ],
  [{ field: "nope", op: "eq", value: 1 }],
  [
    { field: "k", op: "eq", value: 1 },
    { field: "k", op: "eq", value: 2.5 },
  ],
  [
    { field: "k", op: "eq", value: 1 },
    { field: "k", op: "gt", value: 0 },
  ],
  [
    { field: "k", op: "gt", value: 1 },
    { field: "k", op: "gte", value: 2 },
  ],
);

/** A read: a table, maybe an index and a range, maybe a filter, an order, and how it ends. */
export const readArb: fc.Arbitrary<Record<string, unknown>> = fc
  .oneof(
    { arbitrary: fc.constant({ table: "a" }), weight: 1 },
    { arbitrary: rangeOn(["k"], indexedValue).map((range) => ({ table: "a", index: "by_k", range })), weight: 3 },
    {
      arbitrary: rangeOn(["k", "n"], indexedValue).map((range) => ({ table: "a", index: "by_k_n", range })),
      weight: 3,
    },
    { arbitrary: rangeOn(["x"], indexedValue).map((range) => ({ table: "b", index: "by_x", range })), weight: 2 },
    { arbitrary: fc.constant({ table: "a", index: "by_creation_time" }), weight: 1 },
    { arbitrary: badRange.map((range) => ({ table: "a", index: "by_k_n", range })), weight: 1 },
  )
  .chain((base) =>
    fc
      .record(
        {
          order: fc.constantFrom("asc", "desc"),
          filter: fc.record({
            field: fc.constantFrom("k", "n", "x", "extra"),
            op: fc.constantFrom("eq", "neq", "gt", "lt"),
            value: fc.oneof(keyValue, smallInt),
          }),
          mode: fc.constantFrom("collect", "take", "first", "unique"),
          take: fc.integer({ min: 0, max: 4 }),
        },
        { requiredKeys: [] },
      )
      .map((rest) => ({ ...base, ...rest })),
  );

/** An operation before its document references are known: `doc` is an index among the inserts so far. */
type OpTemplate =
  | { kind: "insert"; table: "a" | "b"; doc: Record<string, unknown> }
  | { kind: "patch" | "replaceA" | "replaceB" | "delete" | "get"; doc: number; fields?: Record<string, unknown> }
  | { kind: "read"; read: Record<string, unknown>; mutateResult: boolean }
  | { kind: "throw" }
  // Phase 3: an application error with data, a nested query, a write past a limit, a nested mutation.
  | { kind: "throwData"; data: Value }
  | { kind: "runQuery"; read: Record<string, unknown> }
  | { kind: "limit"; which: number; catch: boolean }
  | { kind: "nested"; ops: OpTemplate[]; catch: boolean };

/** The operations of one transaction, with no nested mutation. */
const flatOpTemplate: fc.Arbitrary<OpTemplate> = fc.oneof(
  { arbitrary: docA.map((doc) => ({ kind: "insert" as const, table: "a" as const, doc })), weight: 4 },
  { arbitrary: docB.map((doc) => ({ kind: "insert" as const, table: "b" as const, doc })), weight: 2 },
  {
    arbitrary: fc.tuple(fc.nat(), patchFields).map(([doc, fields]) => ({ kind: "patch" as const, doc, fields })),
    weight: 3,
  },
  {
    arbitrary: fc.tuple(fc.nat(), docA).map(([doc, fields]) => ({ kind: "replaceA" as const, doc, fields })),
    weight: 1,
  },
  {
    arbitrary: fc.tuple(fc.nat(), docB).map(([doc, fields]) => ({ kind: "replaceB" as const, doc, fields })),
    weight: 1,
  },
  { arbitrary: fc.nat().map((doc) => ({ kind: "delete" as const, doc })), weight: 2 },
  { arbitrary: fc.nat().map((doc) => ({ kind: "get" as const, doc })), weight: 2 },
  {
    arbitrary: fc
      .tuple(readArb, fc.boolean())
      .map(([read, mutateResult]) => ({ kind: "read" as const, read, mutateResult })),
    weight: 3,
  },
  { arbitrary: fc.constant({ kind: "throw" as const }), weight: 1 },
  { arbitrary: anyValue.map((data) => ({ kind: "throwData" as const, data })), weight: 1 },
  { arbitrary: readArb.map((read) => ({ kind: "runQuery" as const, read })), weight: 1 },
  {
    // Rare: each limit's write is the same few calls, and a whole mutation fails when it is not caught.
    arbitrary: fc
      .tuple(fc.constantFrom(...LIMIT_CASES), fc.boolean())
      .map(([which, c]) => ({ kind: "limit" as const, which, catch: c })),
    weight: 1,
  },
);

/** An operation, a nested mutation among them (one level: deeper is the `limit` op's job). */
const opTemplate: fc.Arbitrary<OpTemplate> = fc.oneof(
  { arbitrary: flatOpTemplate, weight: 12 },
  {
    arbitrary: fc
      .tuple(fc.array(flatOpTemplate, { minLength: 1, maxLength: 4 }), fc.boolean())
      .map(([ops, c]) => ({ kind: "nested" as const, ops, catch: c })),
    weight: 2,
  },
);

type StepTemplate =
  | { kind: "query"; read: Record<string, unknown> }
  | { kind: "mutation"; ops: OpTemplate[]; catch: boolean }
  | { kind: "throw" }
  | { kind: "throwData"; data: Value };

const stepTemplate: fc.Arbitrary<StepTemplate> = fc.oneof(
  { arbitrary: readArb.map((read) => ({ kind: "query" as const, read })), weight: 2 },
  {
    arbitrary: fc
      .tuple(fc.array(opTemplate, { minLength: 1, maxLength: 4 }), fc.boolean())
      .map(([ops, c]) => ({ kind: "mutation" as const, ops, catch: c })),
    weight: 4,
  },
  { arbitrary: fc.constant({ kind: "throw" as const }), weight: 1 },
  { arbitrary: anyValue.map((data) => ({ kind: "throwData" as const, data })), weight: 1 },
);

/** Arguments for the validated mutation: right, wrong, missing or extra. */
const typedArgs = fc.record(
  {
    n: fc.oneof(
      fc.integer({ min: -5, max: 5 }),
      fc.double({ noNaN: true }),
      fc.string({ maxLength: 3 }),
      fc.constant(null),
    ),
    s: fc.oneof(fc.string({ maxLength: 3 }), fc.constant(null), fc.integer()),
    bad: fc.boolean(),
    extra: fc.constant(1),
  },
  { requiredKeys: [] },
) as fc.Arbitrary<Record<string, unknown>>;

type CallTemplate =
  | { kind: "apply"; ops: OpTemplate[] }
  | { kind: "read"; read: Record<string, unknown> }
  | { kind: "page"; read: Record<string, unknown>; numItems: number; continueFrom: number | null }
  | { kind: "action"; steps: StepTemplate[] }
  | { kind: "typed"; args: Record<string, unknown> };

const callTemplate: fc.Arbitrary<CallTemplate> = fc.oneof(
  {
    arbitrary: fc.array(opTemplate, { minLength: 1, maxLength: 6 }).map((ops) => ({ kind: "apply" as const, ops })),
    weight: 5,
  },
  { arbitrary: readArb.map((read) => ({ kind: "read" as const, read })), weight: 2 },
  {
    arbitrary: fc
      .tuple(readArb, fc.integer({ min: 1, max: 4 }), fc.option(fc.nat(), { nil: null }))
      .map(([read, numItems, continueFrom]) => ({ kind: "page" as const, read, numItems, continueFrom })),
    weight: 2,
  },
  {
    arbitrary: fc
      .array(stepTemplate, { minLength: 1, maxLength: 4 })
      .map((steps) => ({ kind: "action" as const, steps })),
    weight: 2,
  },
  { arbitrary: typedArgs.map((args) => ({ kind: "typed" as const, args })), weight: 1 },
);

/** Turn templates into a program: document indexes become references to earlier inserts, pages chain. */
export function build(templates: CallTemplate[]): Program {
  const inserted: string[] = [];
  const pages: { name: string; read: Record<string, unknown>; numItems: number }[] = [];
  const program: Program = [];
  for (const t of templates) {
    if (t.kind === "read") {
      program.push({ kind: "read", read: t.read });
      continue;
    }
    if (t.kind === "page") {
      const name = `p${pages.length}`;
      // A page continues an earlier page of the same read (its cursor), or starts one.
      const prev = t.continueFrom === null || pages.length === 0 ? null : pages[t.continueFrom % pages.length]!;
      const read = prev ? prev.read : t.read;
      const numItems = prev ? prev.numItems : t.numItems;
      pages.push({ name, read, numItems });
      program.push({ kind: "page", read, numItems, from: prev ? prev.name : null, as: name });
      continue;
    }
    if (t.kind === "typed") {
      program.push({ kind: "typed", args: t.args });
      continue;
    }
    // Inserts are known to later calls (a reference names an insert of an earlier call: ids exist only once
    // their call commits).
    const before = inserted.length;
    const ref = (i: number) => ({ ref: before === 0 ? "none" : inserted[i % before]! });
    const opsOf = (templates: OpTemplate[]): ProgramOp[] =>
      templates.map((op): ProgramOp => {
        switch (op.kind) {
          case "insert": {
            const as = `r${inserted.length}`;
            inserted.push(as);
            return { kind: "insert", table: op.table, doc: op.doc, as };
          }
          case "patch":
            return { kind: "patch", id: ref(op.doc), fields: op.fields! };
          case "replaceA":
          case "replaceB":
            return { kind: "replace", id: ref(op.doc), doc: op.fields! };
          case "delete":
            return { kind: "delete", id: ref(op.doc) };
          case "get":
            return { kind: "get", id: ref(op.doc) };
          case "read":
            return { kind: "read", read: op.read, ...(op.mutateResult ? { mutateResult: true } : {}) };
          case "throw":
            return { kind: "throw", message: "generated failure" };
          case "throwData":
            return { kind: "throwData", data: op.data };
          case "runQuery":
            return { kind: "runQuery", read: op.read };
          case "limit":
            return { kind: "limit", which: op.which, ...(op.catch ? { catch: true } : {}) };
          default:
            return { kind: "nested", ops: opsOf(op.ops), ...(op.catch ? { catch: true } : {}) };
        }
      });
    if (t.kind === "action") {
      const steps = t.steps.map((st): ActionStep => {
        if (st.kind === "mutation")
          return { kind: "mutation", ops: opsOf(st.ops), ...(st.catch ? { catch: true } : {}) };
        if (st.kind === "throw") return { kind: "throw", message: "generated failure" };
        return st;
      });
      program.push({ kind: "action", steps });
      continue;
    }
    const ops = opsOf(t.ops);
    program.push({ kind: "apply", ops });
  }
  return program;
}

/** A generated program: 1 to `maxCalls` calls. */
export const programArb = (maxCalls = 8): fc.Arbitrary<Program> =>
  fc.array(callTemplate, { minLength: 1, maxLength: maxCalls }).map(build);

export type { Call };

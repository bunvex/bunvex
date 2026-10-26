# STUDY-189 — Public types that accept or refuse what Convex's do not
<!-- index: Public types against Convex 1.46.0's | decided (owner, 2026-10-25) -->

- **Status:** decided (owner, 2026-10-25: every §5 recommendation; the `fieldPaths` gap recorded). Nothing built yet.
- **Convex source read:**
  - the `convex` npm package 1.46.0 (`packages/differential/node_modules/convex`, its `dist/esm-types`);
  - `npm-packages/convex` at `precompiled-2026-10-24-bb31399`;
  - Convex's type tests from the snapshot `c358201e1`: `src/server/{database_api,database,schema,registration,api}.test.ts`
    and `src/values/validator.test.ts`, removed upstream in `ba16e0638`.
- **bunvex code read:** `main` at `e5e00809`.
- **Origin:** the Convex test-gap report (T1–T6), split between two sessions. The runtime items are in
  [STUDY-188](STUDY-188-runtime-test-gaps.md). Every claim below was compiled again here and none is taken from the
  report.
- **Related:** [STUDY-180](STUDY-180-public-api-names.md) (public names), STUDY-36 (staged indexes).

## 1. How the cases were checked

Each case is one `.ts` file, compiled twice with the repo's tsc 5.9.3. The file stays the same and only one `paths`
alias changes: `lib/server` and `lib/values` point either at `packages/bunvex/src/{server,values}.ts` or at convex
1.46.0's types. A "mismatch" is a line that compiles on one side and not on the other. Each fix in §4 was also tried
on a copy of the tree, checked against:
- the root `tsc -p .`;
- `packages/react` and `sync-e2e/react`;
- all 27 `examples/*` tsconfigs.

## 2. What Convex does and what bunvex does

### T1 — `db.patch` takes unknown fields (confirmed)

- **Convex:**
  - `PatchValue<T> = { [P in keyof T]?: undefined extends T[P] ? T[P] | undefined : T[P] }`.
  - `db.patch(id, { nope: 1 })` and a field of another table are TS2353, in the id-first and the table-first forms.
- **bunvex:**
  - `PatchValue` goes through `WithoutSystemFieldsLoose`, an intersection with `Record<string, Value>`
    (`core/src/database-types.ts:284-288`).
  - The index signature accepts any field.
- **Same on both sides:**
  - `replace` refuses unknown fields.
  - `patch(id, { name: 1 })` with the wrong type is refused.
  - `patch(id, { _creationTime: 1 })` is accepted. bunvex's comment "system fields cannot be patched" is wrong on
    both sides.
- **Overload order.** Convex declares the table-first overload of `get`, `patch`, `replace` and `delete` first.
  bunvex declares the id-first one first (`database-types.ts:237-243`, `302-324`). As a result:
  - `Parameters<typeof db.patch>` differs (`["length"]` is `[2,3,3,2]` on bunvex, `[1,2,2,1]` on Convex for
    get/patch/replace/delete);
  - a call that matches neither overload reports a different error.

### T2 — `AnyDataModel` has no system indexes (confirmed)

- **Convex** has `AnyDataModel[string]["indexes"]` = `SystemIndexes` (since `3cfd09626`; it is in 1.46.0).
- **bunvex** has `{}` (`core/src/data-model.ts:37`).
- What breaks on bunvex:
  - `withIndex("by_creation_time")` / `withIndex("by_id")` on `GenericDatabaseReader<AnyDataModel>`, in an app
    without a schema, and on an undeclared table with `strictTableNameTypes: false`: all are TS2345.
  - A boolean-strict data model is not assignable to the generic one. That is Convex's own test "specific DM from
    boolean-strict schema extends generic DM", and convex-test relies on it.
- `core/test/types/data-model.test.ts:68` asserts the wrong `{}`.

### T3 — field paths through unions and id-keyed records (confirmed)

`PathsOf` (`core/src/data-model.ts:108-120`) has two problems.

- **It does not distribute.**
  - `NonNullable<T[K]> extends Record<string, unknown>` is false for `v.union(v.object({ s }), v.number())`.
  - So `"p.s"` is lost, and `q.field("p.s")` is refused.
- **It keeps the id brand.** `keyof T & string` gives a record keyed by ids the path
  `` `r.${string & { __tableName: "t" }}` ``, so `q.field("r.abc")` is refused. Convex accepts both.

Both sides already agree on the rest:
- object unions, `null | object`, string-keyed records, nested objects and union tables;
- `v.any()` fields;
- refusing `arr.x`.

### T4 — an untyped handler's args (confirmed; owner question)

- **Convex:** `query(async (ctx, args) => …)` with no `args` validator gives `args: DefaultFunctionArgs`
  (`Record<string, unknown>`). Then `const n: number = args.x` is TS2322.
- **bunvex:** `Record<string, any>` (`server/src/registration.ts:254-260`).
  - The code comment says it "stays `any` (STUDY-180)", because typing it broke `bench/functions.ts`.
  - But STUDY-180 §3.1 says `DefaultFunctionArgs` "becomes `Record<string, unknown>`, from `any`".
  - `divergences.md` has no entry. The code and the study contradict each other.
- **Matching Convex breaks:**
  - `bench/functions.ts:27-28,40`, which needs validators or annotations;
  - `helpers/test/server/customFunctions.test.ts:145`, which gets back upstream's `@ts-expect-error`.
- None of the 27 examples breaks.

### T5 — staged and unknown fields in index definitions (confirmed, wider than reported)

- **Convex** refuses all of these:
  - `withIndex("st")` on a `{ fields, staged: true }` index (TS2345);
  - `.index("x", ["nope"])` and `.index("x", { fields: ["nope"] })` (TS2769);
  - `.searchIndex("x", { searchField: "nope" })`, `filterFields: ["nope"]` and
    `.vectorIndex("x", { vectorField: "nope" })` (TS2769).
- **bunvex** compiles all of them (`core/src/schema.ts:199-208`):
  - `index` always adds the index to the type, staged or not;
  - a loose overload `index(name: string, config: string[] | {...}): this` takes anything;
  - `searchIndex` / `vectorIndex` drop staged indexes, but type their field names as `string`.
- **Same on both sides:** `_creationTime` in index fields, and any field on a `v.any()` table.
- `core/test/types/data-model.test.ts:51` asserts that a staged index is a `NamedIndex`, since STUDY-36 PR 1. No
  decision for this is recorded.

### T6 — validator children, record keys, `fieldPaths` (partly)

- **Children:**
  - Convex refuses optional children with TS2345: `v.record(required, optional)`, `v.record(optional, required)`,
    `v.union(optional, optional)` and `v.union(required, optional)`.
  - bunvex accepts them. `record` and `union` take `GenericValidator` (`values/src/validators.ts:454-455`).
  - `v.array(optional)` is refused on both sides; the report was wrong there.
- **Record keys:**
  - Convex refuses `v.record(v.number() | v.int64() | v.float64() | v.null() | v.boolean(), …)` with TS2345 ("not
    assignable to `Validator<string, "required", any>`").
  - bunvex accepts them and infers `Record<never, …>`.
  - Ids, unions of ids and literal unions pass on both sides.
- **`fieldPaths`:**
  - No bunvex validator has a `fieldPaths` property (TS2339 on `v.string().fieldPaths`).
  - Convex's validator classes carry a `FieldPaths` type parameter. `VObject` has four type parameters on Convex
    and three on bunvex (`values/src/validators.ts:43-50`).
  - So Convex's "fieldPaths are correctly inferred after omit/pick/extend" cannot even be written against bunvex.

## 3. What an app observes

Types only; nothing changes at runtime. The two directions affect an app differently:
- **A type that accepts what Convex refuses** (T1, T4, T5, T6 children and keys) lets a bug through that Convex's
  build would catch, such as a misspelled patch field or an index on a field that does not exist.
- **A type that refuses what Convex accepts** (T2, T3) fails the build of an app that compiles on Convex.

## 4. How bunvex changes (one PR each, after §5)

| # | Change | Breaks (fixed in the same PR) | Risk |
|---|---|---|---|
| P1 (T2) | `AnyDataModel` gets `indexes: SystemIndexes` | `data-model.test.ts:68` flips | low |
| P2 (T3) | `PathsOf` distributes over unions, and an id key becomes `string` (`KeyPath`, `SubPaths`) | none: only more paths are accepted | low |
| P3 (T1) | Convex's `PatchValue` shape; the four overload pairs swapped to Convex's order | none in examples or helpers (`helpers` triggers already have a Convex-shaped copy) | low |
| P4 (T6 children and keys) | `record<K extends Validator<string,"required">, V extends Validator<any,"required">>`, `union<M extends Validator<any,"required">[]>` | casts at `validators.ts:455,505,507`, `core/src/schema.ts:562`, `helpers/src/validators.ts:618`; `@ts-expect-error` in `values/test/validators.test.ts:67-68` and `undefined-validators.test.ts:59,62` (as upstream's) | low |
| P5 (T5) | Staged indexes leave the type; field names are constrained (`IndexablePaths`) in `index`, `searchIndex` and `vectorIndex`; the loose overload goes | `data-model.test.ts:51`; `@ts-expect-error` or casts in `index-range.test.ts:183-190`, `index-references.test.ts`, `schema-push.test.ts:209`; `schema.ts:719`. Needs P2 first | medium |
| P6 (T4) | Untyped handler args become `DefaultFunctionArgs` | `bench/functions.ts`, `customFunctions.test.ts:145` | medium for apps |
| P7 (T6 `fieldPaths`) | A `FieldPaths` type parameter on every validator class, with the data model's paths derived from it, as Convex's | large; not prototyped | high |

Each PR adds Convex's cases as type tests in `packages/{core,values,server}/test/types/`. The sabotage check is
the old type back, which makes them fail to compile.

## 5. Owner questions

Decided (owner, 2026-10-25): every recommendation below.

| # | Question | Recommendation (decided) |
|---|---|---|
| Q1 (T4) | Untyped handler args: match Convex (`Record<string, unknown>`, as STUDY-180 §3.1 already says), or keep `any` and record a DV? | Match Convex. The comment that keeps `any` contradicts its own study; the cost is two internal files |
| Q2 (T5) | Staged indexes are in the type today, asserted by a test since STUDY-36 PR 1, with no decision recorded. Drop them from the type, and refuse unknown index fields, as Convex does? | Match Convex (P5) |
| Q3 (T6) | `fieldPaths` on every validator changes the public generic shape of `bunvex/values` (`VObject` gets a fourth parameter). Do it now, or record the gap and wait for an app that needs it? | Record it as a gap now; do it later as its own study. P2 already fixes the paths an app can observe |

T1, T2, T3 and T6's children and keys are straight parity fixes (P1–P4) and need no decision.

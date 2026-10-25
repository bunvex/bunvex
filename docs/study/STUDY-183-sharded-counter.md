# STUDY-183 — `@bunvex/sharded-counter`, and how bunvex's component packages are built
<!-- index: `@bunvex/sharded-counter`, the first own component, and the package model every `@bunvex/*` component follows: `components/<name>/`, TypeScript sources in the repo and compiled JS at publish, `_generated/` committed, its own version, the upstream tests ported, a differential test against `@convex-dev/sharded-counter` on Convex, the example app | decided (owner, 2026-10-21): S-1–S-4 -->

- **Status:** decided (owner, 2026-10-21): S-1–S-4 as recommended (§7).
- **Convex source read:** get-convex/sharded-counter at `d8f0718` (0.2.3), pinned in
  [upstream.md](../parity/upstream.md#other-repositories), and the published package `@convex-dev/sharded-counter`
  0.2.3. Paths are relative to the repository's root.
- **bunvex source:** `main`. Paths are relative to the repository's root.
- **Scope:**
  - the first of bunvex's own components ([STUDY-158](STUDY-158-own-components.md) §3.4 step 4.1);
  - the model every later component package follows: layout, exports, `_generated/`, publishing, tests, the example.
- **Related:**
  - [STUDY-158](STUDY-158-own-components.md): Q-1–Q-8, DV-538, DV-539;
  - [STUDY-156](STUDY-156-component-cli.md): a component from npm; DV-532, the offline codegen; DV-533, the export conditions;
  - [STUDY-159](STUDY-159-testing.md): `registerComponent`;
  - [STUDY-160](STUDY-160-client-on-node.md): how packages ship compiled JS.

## 1. How Convex does it

### 1.1 The component

- **Definition.** `defineComponent("shardedCounter")`, with no children (`src/component/convex.config.ts`).
- **Schema.** One table, `counters {name: string, value: number, shard: number}`, with the index
  `name [name, shard]` (`src/component/schema.ts`).
- **Functions** (`src/component/public.ts`). They are public in the component, so the app sees them as internal
  references:
  - `add({name, count, shard?, shards?})`, which returns the shard index.
    - The shard is `shard ?? floor(random * (shards ?? 16))`.
    - The shard's row is read with `.unique()`, then patched to `value + count` or inserted.
  - `count({name})`: the sum of every shard of the name.
  - `rebalance({name, shards?})`.
    - Every shard `0..n-1` is set to `total / n`. That value can be fractional, and it is not rounded.
    - Missing shards are inserted; shards past `n` are deleted.
  - `reset({name})`: deletes the name's rows.
  - `estimateCount({name, readFromShards?, shards?})`.
    - It clamps `readFromShards` to `[1, shards]` and picks that many shards with a Fisher–Yates shuffle.
    - It returns `readCount * shards / readFromShards`.
- **The client** (`src/client/index.ts`).
  - The class is `ShardedCounter<ShardsKey>(component, {shards?, defaultShards?})`.
  - Its methods are `add` (count defaults to 1), `subtract`, `inc`, `dec`, `count`, `rebalance`, `reset`, `estimateCount`, `for(name)` and `trigger(name)`.
    - `trigger(name)` is a convex-helpers `Trigger`: `inc` on insert, `dec` on delete, nothing on update.
    - Its `Trigger` and `Change` types are declared locally.
  - A client instance remembers, per key, the shard it last wrote, and sends it on its later `add`s.
- **`./test`.** `register(t, name = "shardedCounter")` calls `t.registerComponent(name, schema, modules)`.

### 1.2 The package

- **`files`:** `dist` and `src`.
- **`exports`:**
  - `.`: the client (`dist/client`);
  - `./convex.config(.js)`: `dist/component/convex.config.js`;
  - `./_generated/component.js`: types only;
  - `./test`: `src/test.ts`, raw TypeScript.
- **`_generated/`.** `src/component/_generated/` is committed, written by `convex codegen --component-dir ./src/component`.
- **The build.** `tsc` writes `dist`.
- **The example.** `example/` is an app that uses the component (`example/convex/convex.config.ts`) to count checkbox clicks.

### 1.3 Its tests

`src/component/counter.test.ts`:
- `add` and `subtract` across names, with `shards: 1` and `3`;
- an explicit `shard` hits that shard's row;
- `reset`;
- a fast-check property: any sequence of updates sums to the count.

## 2. What an app can observe

STUDY-158 §2 (decided, Q-3) applies:
- **The client API and the component's name.** The app and the dashboard see `shardedCounter`.
- **The schema.** A Convex export of the component's data imports unchanged.
- **The function paths, their validators and their results.** That includes `estimateCount`'s untyped return and `rebalance`'s fractions.

Randomness (the shard picked, `estimateCount`'s sample) is the backend's. Outcomes are compared through invariants: the count is exact, an estimate is within its bounds.

## 3. How bunvex does it

### 3.1 The package model (every `@bunvex/*` component)

- **Where.** `components/<name>/`, a new workspace directory. The root `package.json` lists `components/*`.
- **Layout:**

  | Path | What it holds |
  |---|---|
  | `src/component/bunvex.config.ts` | the definition |
  | `src/component/schema.ts` | the schema |
  | `src/component/*.ts` | the functions |
  | `src/component/_generated/` | written by `bunvex codegen --component-dir src/component` and committed, as Convex's packages do; the CLI's offline codegen (DV-532) gives `ComponentApi` from the validators |
  | `src/client/index.ts` | the client |
  | `src/test.ts` | `register(t, name)` for `@bunvex/testing` (STUDY-159 PR 3) |
  | `test/` | the package's own tests |

- **Exports.** These are Convex's subpaths with bunvex's conditions (DV-533):

  | Subpath | Points to |
  |---|---|
  | `.` | the client |
  | `./bunvex.config.js` | the definition, under the `"@bunvex/component-source"` and `"bunvex"` conditions |
  | `./_generated/component.js` | the types |
  | `./test` | `src/test.ts` |

  - **In the monorepo**, every subpath points to the TypeScript sources. The CLI bundles a definition and its functions from wherever its condition points (STUDY-156), and Bun reads TypeScript. So `"bunvex"` points to `src/component/bunvex.config.ts` too. No build step is needed in the repo.
  - **At publish**, the package gets compiled JS and `.d.ts`, as every `@bunvex/*` package does (STUDY-160). `"bunvex"` points to `dist/component/bunvex.config.js`, and `"@bunvex/component-source"` keeps pointing to `src`. See S-1.
- **Dependencies:**
  - peer dependencies on `@bunvex/server` and `@bunvex/values`;
  - a child component as a regular dependency (STUDY-158 §3.3);
  - `@bunvex/testing` as a dev dependency.
- **Version.** Each package has its own version, outside changesets' fixed group (STUDY-158 Q-1), and starts at 0.1.0 (S-2). The README names the Convex package version it matches.
- **Names.** Rule 5 applies (DV-538): no "convex" in code or strings; the error class is `BunvexError`.

### 3.2 sharded-counter itself

It is written from scratch to §1.1, with Convex's names, paths, validators and defaults:
- 16 shards by default;
- `add`'s count defaults to 1;
- `rebalance`'s fractions;
- `estimateCount`'s clamp and formula;
- the client's remembered shard.

The remembered shard lives on the client instance, in the app's module scope. That is the app's own state; the component's modules keep none (DV-492). On Convex the app's module is evaluated afresh per request, so the remembered shard lasts a request. On bunvex it lasts a code version. This only changes which shard takes a write, never a result (S-3).

`trigger(name)` returns a `Trigger` that `@bunvex/helpers`' `Triggers.register` takes (STUDY-181 PR 5).

### 3.3 Tests

- **The upstream tests, ported** on `@bunvex/testing`, through `registerComponent`: add and subtract, the explicit shard, reset, and the property with fast-check.
- **More:** `rebalance` (fractions, growing and shrinking the shard count), `estimateCount` (clamping, bounds), and the client's `for`, `inc`, `dec` and `trigger` (with `@bunvex/helpers`' `Triggers`).
- **A differential test.** The same sequence of calls goes through `@convex-dev/sharded-counter` 0.2.3 on Convex's binary and through `@bunvex/sharded-counter` on bunvex. It compares:
  - the counts;
  - the component's tables, as sorted values without ids;
  - the errors of bad arguments.
- **The example.** `examples/sharded-counter` is Convex's example app (checkbox clicks counted) written for bunvex, with an end-to-end test like the other examples (STUDY-90).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | none beyond STUDY-158's DV-538 (rule 5) and S-3's note | | |

## 5. Tests

As §3.3, with a sabotage check per behaviour:
- the default of 16 shards;
- `rebalance`'s rounding;
- `estimateCount`'s clamp.

## 6. Not verified yet

- How `bunvex codegen --component-dir` handles a component whose definition is reached through a workspace symlink.
  This is checked in the PR.

## 7. Questions for the owner

All decided by the owner on 2026-10-21, as recommended.

| # | Question | Recommendation |
|---|---|---|
| S-1 | The package model of §3.1: TypeScript sources in the monorepo (no build), compiled JS + `.d.ts` at publish as every `@bunvex/*` package, `_generated/` committed, `components/<name>/` as a workspace | **Yes.** It is Convex's template with bunvex's conditions, and it keeps the repo free of build steps |
| S-2 | Versions: start each component at 0.1.0, its own, with the README naming the Convex version it matches; or copy Convex's version (0.2.3) | **Its own 0.1.0.** Copying Convex's number would suggest the same code |
| S-3 | The client's remembered shard lasting a code version (bunvex evaluates the app's modules once, DV-492) rather than a request | **Accept** (no DV). No result changes, only which shard a write lands on |
| S-4 | Port Convex's example app as `examples/sharded-counter` | **Yes.** It is the end-to-end check, and a user's first look at a bunvex component |

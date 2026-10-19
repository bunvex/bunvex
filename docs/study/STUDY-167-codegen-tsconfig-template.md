# STUDY-167 — The tsconfig.json that `codegen --init` writes

- **Status:** implemented (owner, 2026-10-19: both §6 recommendations accepted)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-36](STUDY-36-codegen.md) G5 (DV-177), [STUDY-160](STUDY-160-client-on-node.md) (the
  published `.d.ts` builds), [STUDY-116](STUDY-116-codegen-flags.md) (`--init`, `--dry-run`)

## 1. How Convex does it

- `npm-packages/convex/src/cli/codegen_templates/tsconfig.ts:1-27` (`tsconfigCodegen`) returns the template:
  a header comment (lines 3-6), a first group of settings "not required by Convex" (`allowJs`, `strict`,
  `moduleResolution: "Bundler"`, `jsx: "react-jsx"`, `skipLibCheck`, `allowSyntheticDefaultImports`; lines
  8-14), a second group "required by Convex" (`target: "ESNext"`, `lib: ["ES2023", "dom"]`,
  `forceConsistentCasingInFileNames`, `module: "ESNext"`, `isolatedModules`, `noEmit`; lines 16-22), then
  `include: ["./**/*"]` and `exclude: ["./_generated"]` (lines 24-25). The source has a trailing comma after
  `noEmit`.
- `npm-packages/convex/src/cli/lib/codegen.ts:521-541` (`doTsconfigCodegen`) writes it to
  `<functionsDir>/tsconfig.json`, skipping a file that exists, through `writeFormattedFile`
  (`codegen.ts:913-931`), which runs prettier with the `json` parser. The file on disk therefore has no trailing
  comma and ends with a newline, as the committed demos show (e.g.
  `npm-packages/demos/args-validation/convex/tsconfig.json`).
- No `allowImportingTsExtensions`: the `convex` package ships `.d.ts` files.

## 2. What an app can observe

The text of `<functions>/tsconfig.json` after `codegen --init` (once, never overwritten), and what the app's
`tsc --project <functions>` accepts with it (the typecheck in `codegen`, `deploy` and `dev`).

## 3. How bunvex does it

`TSCONFIG` in `packages/cli/src/codegen.ts` is now Convex's file as prettier writes it, with "bunvex" for
"Convex" in the three comments (rule 5). Before, it had bunvex's own comment wording and added
`"allowImportingTsExtensions": true` with the comment "bunvex's packages are TypeScript sources, which import
each other by `.ts` paths" (DV-177, STUDY-36 G5).

That was true of the `0.1.0-alpha.1` npm release (the only one so far: its `exports` point `types` at
`./src/*.ts`). Since STUDY-160, `scripts/publish-npm.ts` publishes every package staged by
`scripts/npm-packages.ts`, whose `exports` give TypeScript `dist/{esm,cjs}/*.d.ts`. Those still name their
neighbours by `.ts` paths (`from "./admin-keys.ts"`), but TypeScript reports TS5097 only in source files, not in
declaration files, with `skipLibCheck` on or off (the existing `npm-packages.node.ts` test checks them with it
off). The packages are published together at one
version, and the CLI pins its `@bunvex/*` dependencies to it. So the next release, the first that ships this
template, is also the first with `.d.ts`, and the option is not needed there.

The workspace is different: its `package.json` files export the TypeScript sources, so an app linked to them
(every example in `examples/`, `bench/index-cache-e2e`, the codegen end-to-end tests) still needs the option.
Without it, `tsc -p examples/tutorial/bunvex` reports TS5097 ("An import path can only end with a '.ts'
extension…") in `packages/*/src`, not in the example's own code. The examples' committed `bunvex/tsconfig.json`
files keep the option and are not changed here; no example's functions import `.ts` paths themselves.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | none: DV-177 (STUDY-36 G5) is resolved, the template is Convex's | the published packages ship `.d.ts` (STUDY-160) | owner, 2026-10-19: match Convex (this PR); release timing in §6 |

## 5. Tests

- `packages/cli/test/codegen.test.ts`: `--init` writes exactly Convex's text in bunvex's name (a literal written
  from Convex's template, not from bunvex's constant), and keeps a `tsconfig.json` that exists. The three
  end-to-end tests on the workspace's sources (`initOnSources`) now run `--init`, add the option the sources
  need, then typecheck.
- `packages/sync-e2e/node/npm-packages.node.ts` (`bun run test:npm`, CI job `npm-packages-node`): an app on the
  packages as npm gets them runs `bunvex codegen --init --typecheck enable` and passes with the generated
  tsconfig, which has no `allowImportingTsExtensions`; a table not in the schema then fails the typecheck, so
  the types are the declarations', not `any`.

Sabotage (each restored, checked with `cmp` and `git status`):

| Sabotage | Caught by |
|---|---|
| S1: `allowImportingTsExtensions` back in the template | the template test; the `npm-packages.node.ts` test; the three end-to-end tests (`initOnSources`' guard) |
| S2: a trailing comma after `noEmit` (Convex's source before prettier) | the template test |
| S3: `skipLibCheck` dropped from the template | the template test |
| S4: the staged packages' `types` pointed at the sources (as `0.1.0-alpha.1`) | the `npm-packages.node.ts` test (TS5097) |

## 6. Decisions

- **Release timing (owner, 2026-10-19: accepted).** An app on the `0.1.0-alpha.1` packages that runs `codegen --init` with a CLI
  built from this change gets a tsconfig whose typecheck fails (TS5097 in the packages' sources). That needs a
  newer CLI with older packages, since releases are published together; existing tsconfigs are never
  rewritten. Decided: merge, and let the next release (the first built one) ship it.
- **The examples (owner, 2026-10-19: accepted).** They keep `allowImportingTsExtensions` because the workspace links the sources.
  They could instead link built packages, which needs a build in the workspace. Decided: keep them as
  they are.

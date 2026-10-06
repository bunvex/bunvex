# STUDY-116 — `codegen`'s other flags: `--dry-run`, `--debug`, `--commonjs`, and the rest

- **Status:** implemented; the divergences decided by the owner (2026-10-05: DV-384, DV-385, DV-386)
- **Convex source read:** commit `4577b903` of get-convex/convex-backend
- **Related:** [STUDY-36](STUDY-36-codegen.md) (codegen, DV-173: no deployment), [STUDY-43](STUDY-43-data-command.md)
  (`data --component`), [platform §12](../parity/platform.md#12-cli-npx-convex-)

## 1. How Convex does it

`npx convex codegen` (`npm-packages/convex/src/cli/codegen.ts`) declares:

| Flag | Help | Meaning |
|---|---|---|
| `--dry-run` | shown | print, do not write |
| `--debug` | hidden | print every file |
| `--typecheck enable\|try\|disable` | shown, default `try` | (STUDY-36) |
| `--init` | shown | also write `README.md` and `tsconfig.json` (STUDY-36) |
| `--admin-key`, `--url` | hidden | the deployment to run codegen against |
| `--live-component-sources` | hidden | bundle components from source |
| `--commonjs` | hidden ("Experimental option") | also generate a CommonJS api |
| `--system-udfs` | hidden ("Only for doing codegen on system UDFs") | Convex's own system functions: no deployment |
| `--component-dir <path>` | shown | codegen for one component directory |

All of them become a `CodegenOptions` (`lib/codegen.ts:74`) and go to `runCodegen` (`lib/components.ts:92`).

**Writing** (`writeFormattedFile`, `lib/codegen.ts:915`). Every generated file goes through it, prettier-formatted:

- with `debug`: `logOutput("# " + path.resolve(destination))`, then `logOutput(contents)`, and return —
  every file, changed or not, on stdout; nothing is written. (A comment says Convex's
  `test_codegen_projects_are_up_to_date` smoke test depends on this format.)
- otherwise, if the file already holds the contents, return;
- with `dryRun`: `logOutput("Command would write file: " + destination)` and return. `destination` is
  `path.join(<functions dir>, "_generated", <name>)`, where the functions directory is
  `path.join(dirname("convex.json"), functions)`: a path relative to the project, `convex/_generated/api.js`;
- else write it (through a temporary file).

**Stale entries** (`cleanupStaleGeneratedEntries`, `lib/codegen.ts:54`): skipped entirely with `debug`
("we don't actually write files in that mode"). With `dryRun`, `recursivelyDelete` (`lib/fsUtils.ts:6`) prints
`Command would delete file: <path>` per file and `Command would delete directory: <path>` after a directory's
contents, and deletes nothing.

`prepareForCodegen` (`lib/codegen.ts:125`) still makes `_generated/` (`mkdir` recursive), in a dry run too.
`--init` (`doInitConvexFolder`) passes `dryRun` / `debug` to the README and tsconfig writes, so they are
printed the same way. The typecheck runs after codegen in every mode.

**`--commonjs`.** `generateCommonJSApi: options.commonjs` (`lib/components.ts:131`); each pass ORs it with
`convex.json`'s top-level `generateCommonJSApi` (`lib/codegen.ts:168, 257, 464`). Only in the `.js` + `.d.ts`
layout (the `.ts` branches ignore it), it adds:

- `api_cjs.cjs`: the header, `const { anyApi } = require("convex/server");` and
  `module.exports = { api: anyApi, internal: anyApi };` (`codegen_templates/api_cjs.ts`,
  `component_api.ts:45 rootComponentApiCJS`);
- `api_cjs.d.cts`: the same declarations as `api.d.ts` (`apiCjsCodegen` reuses its DTS; the final component
  pass writes `apiContents` to both).

The initial (pre-bundle) pass writes `api_cjs.cjs` always and the `api_cjs.d.cts` stub (`AnyApi`) only if it
is missing, like `api.js` / `api.d.ts` (`lib/codegen.ts:797`). `server.js` has no CommonJS twin. In
`convex.json`, `generateCommonJSApi: true` with `codegen.fileType: "ts"` is refused
(`lib/config.ts:366`): "Cannot use `generateCommonJSApi: true` with `codegen.fileType: "ts"`. CommonJS modules
require JavaScript generation. Either set `codegen.fileType: "js/dts"` or remove `generateCommonJSApi`." at
path `generateCommonJSApi`, after the fields' own checks (a zod refinement); a non-boolean is zod's
"Expected boolean, received …".

**`--url` / `--admin-key`** select the deployment `startComponentsPushAndCodegen` runs a dry-run `start_push`
against. **`--component-dir`** makes a synthetic root for one component (`lib/components.ts:267`), and
**`--live-component-sources`** adds the `@convex-dev/component-source` condition. **`--system-udfs`** runs the
legacy `doCodegen` alone, without a deployment.

Because Convex's normal path is the two passes of a push (initial codegen, bundle, `start_push`, final
codegen), a dry run on a fresh project lists some files twice (once per pass); `doCodegen` (the
`--system-udfs` path) is a single pass in dependency order: `dataModel`, `server`, `api`, `api_cjs`.

## 2. What an app can observe

- `--dry-run`: exit 0, nothing written, stdout one `Command would write file: <relative path>` line per
  changed file, then the stale entries' `Command would delete …` lines.
- `--debug`: stdout `# <absolute path>` and the file's contents for every file; nothing written or removed.
- `--commonjs` / `generateCommonJSApi`: `_generated/api_cjs.cjs` loads with `require()` and exports `api` and
  `internal`; `api_cjs.d.cts` types them.
- The flags parse (`--url`, `--admin-key` take a value); unknown flags are errors.

## 3. How bunvex does it

`packages/cli/src/codegen.ts`, `codegen-command.ts`, `deploy.ts` (bunvex.json).

- `runCodegen` and `initFunctionsDir` take a `WriteMode` (`dryRun`, `debug`, the project directory, an output
  line). `writeIfChanged` is Convex's order of checks: debug prints and returns; an unchanged file is
  skipped; a dry run prints `Command would write file: <path relative to the project>`. Stale entries print
  Convex's delete lines, deepest first, or (debug) are left alone. `_generated/` is still made, as Convex's.
- In a dry or debug run, `bunvex codegen`'s own last line (`✔ Generated …`) and `--init`'s `Wrote …` lines
  are not printed, so stdout is exactly Convex's.
- `--commonjs`, and `generateCommonJSApi` in bunvex.json (top level, as Convex's; checked with Convex's
  messages, the refinement included), add `api_cjs.cjs` (`require("bunvex/server")`, or `@bunvex/server` for
  an app on the scoped packages) and `api_cjs.d.cts` (the `api.d.ts` text) in the `js/dts` layout, in both
  passes, with Convex's initial-pass rules. bunvex.json's key also applies to `deploy` and `dev`, as Convex's.
- `--url` / `--admin-key` are accepted with their value and ignored (DV-384); `--component-dir` and
  `--live-component-sources` are refused with "bunvex codegen: <flag>: bunvex does not have components yet."
  (exit 2), as `data --component` (DV-385); `--system-udfs` is an unknown option (DV-386).
- Help: `--dry-run`, `--init`, `--typecheck` are listed; `--debug`, `--commonjs`, `--url`, `--admin-key` are
  hidden, as Convex's.

`bunvex codegen` is one pass, from the code alone (DV-173), in `doCodegen`'s order, so a dry run lists each
file once; Convex's push path can list a file twice. This is part of DV-173 (no `start_push`), not a new
divergence.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| F1 (DV-384) | `--url` and `--admin-key` are accepted and ignored | Codegen reads no deployment (DV-173); accepting them keeps Convex scripts working | owner, 2026-10-05 |
| F2 (DV-385) | `--component-dir` and `--live-component-sources` are refused: "bunvex does not have components yet" | Ainda não fizemos: no components (as `data --component`, DV-224) | owner, 2026-10-05 |
| F3 (DV-386) | `--system-udfs` is not an option | It generates Convex's own system functions; bunvex's system functions are not written as a functions directory | owner, 2026-10-05 |

## 4b. Additions (beyond Convex)

None.

## 5. Tests

`packages/cli/test/codegen.test.ts`, "bunvex codegen --dry-run, --debug, --commonjs and the other flags":

- `--dry-run` on a fresh app: stdout is exactly the five `Command would write file: bunvex/_generated/…` lines
  and the stale entry's `Command would delete file` / `directory` lines; every file on disk unchanged. After a
  real run, a dry run prints nothing; after adding a module, only `api.d.ts`.
- `--init --dry-run`: the README and tsconfig lines, neither written.
- `--debug`: `# <absolute path>` and the contents of all five files (unchanged ones included), equal to
  `generatedFiles`; nothing written, the stale file kept.
- `--url <url> --admin-key=<key>`: the same result as without; `--url` with no value is exit 2.
- `--component-dir`, `--component-dir=x`, `--live-component-sources`: exit 2 with the message;
  `--system-udfs`: unknown option.
- `--commonjs`: `api_cjs.cjs` and `api_cjs.d.cts` (= `api.d.ts`); `require()` of `api_cjs.cjs` in Bun gives
  `api.messages.list` / `internal.a.b` whose `getFunctionName` is `messages:list` / `a:b`. A run without it
  removes them; `generateCommonJSApi: true` in bunvex.json writes them in the initial pass (stub
  declarations) and the final pass (typed); the initial pass rewrites a changed `api_cjs.cjs`; with
  `fileType: "ts"` the flag adds nothing.
- bunvex.json: `generateCommonJSApi: "yes"` and `true` with `fileType: "ts"` give Convex's messages.

Sabotage (each broke a test, then restored; `git diff` clean):

| Sabotage | Failed |
|---|---|
| dry-run prints the absolute path | dry-run, `--init --dry-run` |
| dry-run lists unchanged files too | dry-run |
| debug removes stale entries | debug |
| debug header without the full path | debug |
| `api_cjs.cjs` without `internal` | commonjs |
| the initial pass writes `api_cjs.cjs` only when missing | commonjs |
| `--admin-key` not accepted | `--url` / `--admin-key` |
| the `generateCommonJSApi` + `ts` refinement off | bunvex.json case |

No oracle against the `convex` package: its CLI is not importable as a library; the expected lines are read
from the source above.

## 6. Open questions

None.

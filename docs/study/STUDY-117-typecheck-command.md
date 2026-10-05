# STUDY-117 — `bunvex typecheck`, `tsgo` and `typescriptCompiler`

- **Status:** implemented; DV-387 decided by the owner (2026-10-05); one open question (§6)
- **Convex source read:** commit `4577b903` of get-convex/convex-backend
- **Related:** [STUDY-36](STUDY-36-codegen.md) (the typecheck step of `codegen`, `deploy`, `dev`),
  [platform §12](../parity/platform.md#12-cli-npx-convex-)

## 1. How Convex does it

**The command** (`npm-packages/convex/src/cli/typecheck.ts`): `npx convex typecheck [--typescript-compiler
tsc|tsgo]`, described as "Run TypeScript typechecking on your Convex functions with `tsc --noEmit`." It takes
no other options, and it reads no deployment.

**The compiler** (`lib/typecheck.ts`):

- `resolveTypescriptCompiler`: the flag, else `convex.json`'s `typescriptCompiler` (`"tsc" | "tsgo"`,
  `lib/config.ts:338`), else `tsc`. The deploy / dev / codegen step (`typeCheckFunctionsInMode`) uses the same
  resolution, without a flag.
- `findTypeScriptCompilerPath`, from the project directory:
  - `tsgo`: `node_modules/@typescript/native-preview/bin/tsgo`, then `bin/tsgo.js` (the older preview name);
  - `tsc`: `node_modules/@typescript/native/bin/tsc` (TypeScript 7's alias), then
    `node_modules/typescript/bin/tsc`.

**The run** (`typeCheckFunctions`, `runTsc`, `runTscInner`):

1. With no `<functions>/tsconfig.json`, the result is `cantTypeCheck`, with "Found no convex/tsconfig.json to
   use to typecheck Convex functions, so skipping typecheck." and "Run `npx convex codegen --init` to create
   one.".
2. With no compiler, the result is `cantTypeCheck`, with "No \`<compiler>\` binary found, so skipping
   typecheck.".
3. It runs `<compiler> --version` and keeps the version.
4. It runs `<node> <compiler> --project <functionsDir> --listFiles` with the output captured. The listed files
   go to the file watcher.
5. Exit 0 is `success`. Output starting `error TS18003` ("No inputs were found") is also `success`.
6. Otherwise the result is `typecheckFailed`. The specific error is "✖ TypeScript typecheck via \`tsc\` failed."
   (it says `tsc` even for tsgo). The error printer reruns `<compiler> --project <functionsDir> --pretty true`
   with `stdio: "inherit"`, so the compiler's colored errors go to the terminal (stdout).
7. After the run, a TypeScript older than 4.8.4 prints "Convex works best with TypeScript version 4.8.4 or
   newer -- npm i --save-dev typescript@latest to update.". This is reached only when the result handler
   returns, which is never in the command (it exits), and only on success in the deploy / dev / codegen step.

Neither run passes `--noEmit`: Convex relies on the `tsconfig.json` its `codegen --init` writes, which has
`"noEmit": true`.

**The command's handler:**

- `cantTypeCheck`: the specific lines, then "Unable to typecheck; is TypeScript installed?", exit 1.
- `typecheckFailed`: "✖ TypeScript typecheck via `tsc` failed.", then "Typecheck failed", then the `--pretty
  true` rerun's output, exit 1.
- `success`: "✔ Typecheck passed: \`<compiler> --noEmit\` completed with exit code 0.", exit 0.

The ✔ / ✖ lines and the plain lines go to stderr (`logFinishedStep`, `logFailure`, `logMessage`).

## 2. What an app can observe

- The exit code: 0 on success, 1 on a type error or when the typecheck cannot run.
- The lines above on stderr, and the compiler's pretty errors on stdout.
- The compiler chosen by the flag or by `typescriptCompiler`.
- The compiler's own behaviour: it runs on the functions' `tsconfig.json`.

## 3. How bunvex does it

`packages/cli/src/typecheck.ts` holds the command. `codegen.ts` holds `runTypecheck`, which the command and
the deploy / dev / codegen step (`typecheck(mode)`) share. `deploy.ts` holds bunvex.json's
`typescriptCompiler`, checked with Convex's zod messages.

- The compiler lookup and its order are Convex's.
- The compiler runs with bunvex's runtime: `process.execPath` with `BUN_BE_BUN`, as before (STUDY-39).
- One run: `<compiler> --noEmit --project <functionsDir relative to the project> --pretty true` (owner,
  DV-387). Its output is what Convex's rerun prints.
- bunvex has no file watcher fed by `--listFiles`, so there is no first `--listFiles` run. That run's output
  is never shown in Convex, so dropping it changes only the time taken.
- `--version` runs in parallel with the typecheck.
- TS18003 is read from the uncolored output.
- The command's lines are Convex's: the ✔ / ✖ lines and "Typecheck failed" / "Unable to typecheck; is
  TypeScript installed?" on stderr, and the compiler's output on stdout.
- The `cantTypeCheck` lines keep bunvex's STUDY-36 wording: "Found no bunvex/tsconfig.json to typecheck the
  functions with, so skipping typecheck. Run \`bunvex codegen --init\` to create one.". The tsconfig path is
  the real one; Convex's message always says `convex/tsconfig.json`.
- deploy / dev / codegen now:
  - use `typescriptCompiler`;
  - get `--pretty true` output (the errors as `file:line:column`, colored, as Convex's rerun);
  - print the old-TypeScript warning ("bunvex works best with …") after a typecheck that passed.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| T1 (DV-387) | The compiler runs with `--noEmit` too | Convex does not pass `--noEmit`: it relies on the `"noEmit": true` of the tsconfig its `codegen --init` generates. bunvex passes it so that a typecheck never writes files. Observable only with a functions `tsconfig.json` that emits: Convex would write the `.js` files and bunvex does not | owner, 2026-10-05 (confirmed after review: keep `--noEmit`) |

## 4b. Additions (beyond Convex)

None.

## 5. Tests

`packages/cli/test/typecheck.test.ts`:

- **The real `tsc`.**
  - A clean project: exit 0, stderr exactly the ✔ line, stdout empty.
  - A type error: exit 1, stderr the two failure lines, stdout the colored pretty errors with
    `bunvex/a.ts:1:14 - error TS2322`.
- **When it cannot run.**
  - No TypeScript: "No \`tsc\` binary found" (and \`tsgo\` with the flag), then "Unable to typecheck …", exit 1.
  - No tsconfig: the same, with the tsconfig line.
- **Bad values.** A bad `--typescript-compiler` exits 2. Bad bunvex.json values give Convex's zod messages.
- **Stand-in compilers.** These are scripts that record their arguments.
  - `--typescript-compiler=tsgo` runs `bin/tsgo` (before `bin/tsgo.js`) with exactly
    `--noEmit --project bunvex --pretty true`, and prints "\`tsgo --noEmit\`".
  - bunvex.json's `typescriptCompiler: "tsgo"` (with a custom `functions` directory) picks `tsgo.js` once
    `tsgo` is gone, and the flag `tsc` overrides it.
  - `@typescript/native` is used before `typescript`.
  - A colored TS18003 passes; another failure prints the output.
  - TypeScript 4.8.3 gets the warning after `bunvex codegen`, and not from `bunvex typecheck`; 4.8.4 gets none.
- **Existing tests.** The codegen and deploy tests now expect the pretty `file:line:` form.

Sabotage (each broke a test, then restored; `git diff` clean):

| Sabotage | Failed |
|---|---|
| no `--noEmit` | tsgo arguments |
| no `--pretty true` | real type error; tsgo arguments |
| `tsgo.js` before `tsgo` | tsgo arguments |
| `typescript` before `@typescript/native` | native first |
| TS18003 checked on the colored output | TS18003 |
| bunvex.json's `typescriptCompiler` ignored | tsgo from bunvex.json |
| the ✔ line always says `tsc` | tsgo |
| the compiler's errors on stderr | real type error; TS18003 / other failure |
| the version threshold at 4.8.3 | older TypeScript |

**Measurement.** The `--version` run is in parallel with the typecheck. On a one-file project, the median of
10 runs was 448 ms for the typecheck alone and 450 ms with the version check
(`scratchpad/agent-cli1/bench.ts`).

## 6. Open questions

- **The deploy / dev / codegen step's failure output (not changed here).**
  - Convex prints "✖ TypeScript typecheck via \`tsc\` failed." and "To ignore failing typecheck, use
    \`--typecheck=disable\`." on stderr, then the compiler's errors on stdout.
  - bunvex (STUDY-36) prints the errors, then the "To ignore" line, all on stderr, with no ✖ line.
  - This was found while reading Convex for this study, and it is left for the owner.

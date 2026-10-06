# STUDY-124 — The CLI's argument errors and failed-typecheck output, as Convex's

- **Status:** implemented (owner decisions, 2026-10-05; DV-388)
- **Convex source read:** commit `4577b903` of get-convex/convex-backend; commander 14.0.3 (Convex's
  `commander ^14.0.3`)
- **Related:** [STUDY-36](STUDY-36-codegen.md), [STUDY-117](STUDY-117-typecheck-command.md),
  [STUDY-116](STUDY-116-codegen-flags.md), [STUDY-118](STUDY-118-usage-limits-cli.md)

## 1. How Convex does it

### 1.1 A failed typecheck in deploy, dev and codegen

`typeCheckFunctionsInMode` (`npm-packages/convex/src/cli/lib/typecheck.ts`) passes a result handler to
`typeCheckFunctions`. On `typecheckFailed`, and on `cantTypeCheck` with `--typecheck=enable`, the handler does
four things:

1. `logSpecificError()`.
   - For a failure this is `logFailure("TypeScript typecheck via \`tsc\` failed.")`, which prints `✖ …` on
     stderr. The text says `tsc` even when `tsgo` ran.
   - When the typecheck cannot run, it prints the reason lines instead ("Found no … tsconfig.json …", "No
     \`tsc\` binary found …").
2. `logError("To ignore failing typecheck, use \`--typecheck=disable\`.")` on stderr.
3. `runOnError()`: it reruns the compiler with `--pretty true` and `stdio: "inherit"`, so the compiler's errors
   go to stdout. This happens only for a failure.
4. `ctx.crash({ exitCode: 1, printedMessage: null })`, which prints nothing more.

### 1.2 Argument errors

Convex parses its arguments with commander 14 (`cli/program.ts`, one `Command` per command).

**The output.** `Command.error` (`commander/lib/command.js`):

- writes `error: <message>` to stderr;
- if the command was built with `showHelpAfterError()`, also writes an empty line and the command's help, to
  stderr;
- exits 1.

**Which commands show help after the error.** The program, and `dev`, `deploy`, `run`, `import`, `export`,
`data`, `logs`, `function-spec`, `dashboard`, `insights` and the deployment-token commands. `addCommand` does not
copy the setting to subcommands. So `codegen`, `env` (and its subcommands), `typecheck` and `deployment …`
print the error line alone.

**The messages:**

| Case | Message |
|---|---|
| unknown option | `unknown option '<flag>'`, then a suggestion for `--` flags |
| unknown command | `unknown command '<name>'`, then a suggestion |
| missing option value | `option '<flags>' argument missing` |
| a choice outside the list | `option '<flags>' argument '<v>' is invalid. Allowed choices are a, b.` |
| an `argParser` that throws | `option '<flags>' argument '<v>' is invalid. <its message>` (`parseInteger`: "Not a number."; `parsePositiveInteger`: "Not a positive number.") |
| a required option left out | `required option '<flags>' not specified` |
| a required argument left out | `missing required argument '<name>'` |
| more arguments than declared (`allowExcessArguments(false)`) | `too many arguments for '<command>'. Expected N argument(s) but got M.` |

`<flags>` is the option as declared, for example `--admin-key <adminKey>` or `--limit <n>`.

**Suggestions** (`suggestSimilar`):

- The candidates are the visible long options (with `--help`) or the visible commands.
- A candidate qualifies at an optimal-string-alignment distance of at most 3 and more than 40% similarity.
  One-character candidates are skipped.
- The candidates at the best distance are sorted, then printed as `\n(Did you mean X?)` or `\n(Did you mean one
  of X, Y?)`.

**No subcommand.** Running the program (or `env`) with no subcommand prints its help to stderr and exits 1.

**Options declared as conflicting.** `import` (`--replace` / `--append` / `--replace-all`) and `dev` (`--run`
/ `--start`) declare them by their flags: `.conflicts("--append")`. Commander compares the names against
attribute names (`append`), so the check never fires (verified against commander 14.0.3). Convex then picks one
mode:

- `import`: `--append`, else `--replace`, else `--replace-all` (`lib/convexImport.ts`);
- `dev`: `--run` over `--start` (`lib/command.ts`).

**Optional values.** `--tail-logs [mode]` and `--history [n]` take the next argument as their value unless it
starts with `-`. Alone, `--tail-logs` means `pause-on-deploy`.

**`run` without a function.** `[functionName]` is optional to commander. The action prints "`npx convex run`
requires either <functionName> or `--inline-query`." and exits 1.

## 2. What an app can observe

Scripts and operators see these streams, texts and exit codes.

## 3. How bunvex does it

`packages/cli/src/args.ts`:

- `argumentError(io, message, help?)` prints `error: …`, then (for the commands Convex shows help on) a blank
  line and bunvex's usage text, and returns 1;
- builders for each commander message;
- bunvex's own `suggestSimilar`, compared with commander's on 40 000 random inputs with no mismatch
  (`scratchpad/agent-cli1/oracle.ts`);
- the candidates for a suggestion are the long options a command's help lists, plus `--help`.

Every command uses them (`admin-key`, `codegen`, `data`, `deploy`, `dev`, `env`, `export`, `function-spec`,
`import`, `logs`, `run`, and the program). Commands now check their argument counts before they connect.

Other changes that follow Convex:

- `bunvex` and `bunvex env` with no subcommand print the help on stderr and exit 1.
- `import` resolves several mode flags by Convex's precedence, and `dev` lets `--run` win over `--start`.
  bunvex used to refuse these combinations; Convex never does.
- `--tail-logs` alone means `pause-on-deploy`.
- A `--history` value that is not a number is "Not a number.".
- `--limit` follows `parsePositiveInteger`.
- `run` without a function prints "✖ \`bunvex run\` requires <functionName>." (bunvex has no
  `--inline-query`, DV-186).

bunvex's own refusals keep their text with the new prefix and exit code:

- `--component` gives `error: --component: bunvex does not have components yet.` (DV-224).
- The bunvex-only checks have no Convex counterpart: admin-key's options, and dev's port check, which gives
  "Not a port number.".

`codegen.ts` `printTypecheckFailure` prints a failed typecheck for deploy, dev and codegen, in Convex's order:
the ✖ line or the reason, then the hint, on stderr; the compiler's errors on stdout. The ✖ line names the
compiler that ran (DV-388). Until `tsgo` lands (#435) that is always `tsc`. `--pretty true` for those errors
also comes with #435.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| O1 (DV-388) | The ✖ line names the compiler that ran ("via \`tsgo\`") | Convex's text always says `tsc`; the owner asked for the actual name | owner, 2026-10-05 |

## 4b. Additions (beyond Convex)

None.

## 5. Tests

Updated across `packages/cli/test`:

| Test file | What it now expects |
|---|---|
| `admin-key` | The exact errors, a suggestion (`--sytem` → `--system`), the unknown command with the help after it, a command suggestion (`deplyo` → `deploy`), and no command (help on stderr, exit 1). |
| `data` | Every choice and parser message, too many arguments, a suggestion, the help after each, and `--component`. |
| `deploy` | A bad `--codegen`, with the help after it. |
| `deploy` and `codegen`: failed typecheck | The ✖ line and the hint on stderr, and the errors on stdout. `--typecheck=enable` with no tsconfig gives the reason, then the hint. |
| `codegen` | A bad `--typecheck`, with no help after it. |
| `dev` | `--run` with `--start` runs the function and not the command. |
| `import` | Both mode flags give no error; too many paths; no path. |
| `export` | The required `--path`. |
| `logs` | `--history x`, and an unknown option with a suggestion. |
| `run` | No function, and too many arguments. |
| `function-spec`, `local-deployment` | Exit 1. |

The oracle `scratchpad/agent-cli1/oracle.ts` runs commander 14.0.3 next to `args.ts`:

- `suggestSimilar` matched on 40 000 random words, for options and for commands.
- The unknown-option, choice, missing-argument, required-option and too-many-arguments messages are identical.
- A declared `--start` / `--run` conflict printed nothing, which confirms §1.2.

Sabotage: see the PR.

## 6. Open questions

None.

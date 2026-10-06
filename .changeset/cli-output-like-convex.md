---
"@bunvex/cli": patch
---

The CLI prints argument errors as Convex's does (commander's format): `error: <message>`, with "Did you mean …?" suggestions and, for the commands where Convex does, a blank line and the command's help; the exit code is 1 (it was 2). `bunvex` and `bunvex env` with no subcommand print the help on stderr and exit 1. As in Convex, `import` with several mode flags and `dev --run` with `--start` are no longer refused (`--append` and `--run` win), and `--tail-logs` alone means `pause-on-deploy`. A failed typecheck in `deploy`, `dev` and `codegen` prints "✖ TypeScript typecheck via `tsc` failed." and the `--typecheck=disable` hint on stderr, then the compiler's errors on stdout.

// `bunvex typecheck` (STUDY-117): Convex's `npx convex typecheck` (npm-packages/convex/src/cli/typecheck.ts,
// lib/typecheck.ts): the functions typechecked with the app's own compiler — `tsc`, or `tsgo` from
// `@typescript/native-preview` — chosen by `--typescript-compiler`, else bunvex.json's `typescriptCompiler`,
// else `tsc`. Convex's messages; the compiler's own output on stdout, ours on stderr.
import { runTypecheck, type TypescriptCompiler } from "./codegen.ts";
import { functionsDir, typescriptCompilerOf } from "./deploy.ts";
import type { Io } from "./io.ts";

export const TYPECHECK_USAGE = `Usage: bunvex typecheck [options]

Run TypeScript typechecking on your bunvex functions with \`tsc --noEmit\`.

Options:
  --typescript-compiler <compiler>
                       tsc or tsgo (\`@typescript/native-preview\` must be installed to use \`tsgo\`); default:
                       "typescriptCompiler" in bunvex.json, else tsc`;

export async function typecheckCommand(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(TYPECHECK_USAGE);
    return 0;
  }
  let flag: TypescriptCompiler | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (name === "--typescript-compiler") {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
      if (v !== "tsc" && v !== "tsgo") {
        io.err(`bunvex typecheck: --typescript-compiler must be tsc or tsgo\n\n${TYPECHECK_USAGE}`);
        return 2;
      }
      flag = v;
    } else {
      io.err(`bunvex typecheck: unknown option ${a}\n\n${TYPECHECK_USAGE}`);
      return 2;
    }
  }
  try {
    const compiler = flag ?? typescriptCompilerOf(io.cwd);
    const result = await runTypecheck(functionsDir(io.cwd), io.cwd, compiler);
    if (result.kind === "cantTypecheck") {
      io.err(result.why);
      io.err("Unable to typecheck; is TypeScript installed?");
      return 1;
    }
    if (result.kind === "failed") {
      // As Convex's: its failure lines, then the compiler's errors (its second, `--pretty true` run).
      io.err("✖ TypeScript typecheck via `tsc` failed.");
      io.err("Typecheck failed");
      if (result.output) io.out(result.output);
      return 1;
    }
    // Convex's command exits before its old-TypeScript warning would print, so there is none here.
    io.err(`✔ Typecheck passed: \`${compiler} --noEmit\` completed with exit code 0.`);
    return 0;
  } catch (e) {
    io.err(`bunvex typecheck: ${(e as Error).message}`);
    return 1;
  }
}

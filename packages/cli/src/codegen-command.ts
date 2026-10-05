// `bunvex codegen` (STUDY-36): write the functions directory's `_generated/`, then typecheck. Convex's
// dynamic modes need nothing but the code, so no deployment is involved (G1); `--init` writes
// `tsconfig.json` and `README.md` first.
import { relative } from "node:path";
import { argumentError, invalidChoice, missingArgument, optionsIn, tooManyArguments, unknownOption } from "./args.ts";
import { initFunctionsDir, printTypecheckFailure, runCodegen, type TypecheckMode, typecheck } from "./codegen.ts";
import { codegenConfig, functionsDir } from "./deploy.ts";
import type { Io } from "./io.ts";

export const CODEGEN_USAGE = `Usage: bunvex codegen [options]

Generate the functions directory's _generated/ (api, server, dataModel), then typecheck the functions.

Options:
  --init               also write tsconfig.json and README.md in the functions directory
  --typecheck <mode>   enable, try (default) or disable`;

export async function codegenCommand(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(CODEGEN_USAGE);
    return 0;
  }
  let init = false;
  let mode: TypecheckMode = "try";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--init") init = true;
    else if (a === "--typecheck" || a.startsWith("--typecheck=")) {
      // Argument errors as Convex's commander prints them; `codegen` shows no help after them.
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
      if (v === undefined) return argumentError(io, missingArgument("--typecheck <mode>"));
      if (v !== "enable" && v !== "try" && v !== "disable")
        return argumentError(io, invalidChoice("--typecheck <mode>", v, ["enable", "try", "disable"]));
      mode = v;
    } else if (a.startsWith("-")) return argumentError(io, unknownOption(a, optionsIn(CODEGEN_USAGE)));
    else return argumentError(io, tooManyArguments("codegen", 0, args.filter((x) => !x.startsWith("-")).length));
  }
  try {
    const dir = functionsDir(io.cwd);
    if (init) for (const f of initFunctionsDir(dir)) io.err(`Wrote ${relative(io.cwd, dir)}/${f}`);
    const result = runCodegen(dir, codegenConfig(io.cwd));
    const checked = await typecheck(dir, io.cwd, mode);
    if (!checked.ok) {
      printTypecheckFailure(io, checked);
      return 1;
    }
    if (checked.skipped && checked.skipped !== "disabled") io.err(checked.skipped);
    io.out(
      result.written.length
        ? `✔ Generated ${relative(io.cwd, dir)}/_generated (${result.written.join(", ")})`
        : `✔ ${relative(io.cwd, dir)}/_generated is up to date`,
    );
    return 0;
  } catch (e) {
    io.err(`bunvex codegen: ${(e as Error).message}`);
    return 1;
  }
}

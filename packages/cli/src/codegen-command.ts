// `bunvex codegen` (STUDY-36): write the functions directory's `_generated/`, then typecheck. Convex's
// dynamic modes need nothing but the code, so no deployment is involved (G1); `--init` writes
// `tsconfig.json` and `README.md` first.
import { relative } from "node:path";
import { initFunctionsDir, runCodegen, type TypecheckMode, typecheck } from "./codegen.ts";
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
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
      if (v !== "enable" && v !== "try" && v !== "disable") {
        io.err(`bunvex codegen: --typecheck must be enable, try or disable\n\n${CODEGEN_USAGE}`);
        return 2;
      }
      mode = v;
    } else {
      io.err(`bunvex codegen: unknown option ${a}\n\n${CODEGEN_USAGE}`);
      return 2;
    }
  }
  try {
    const dir = functionsDir(io.cwd);
    if (init) for (const f of initFunctionsDir(dir)) io.err(`Wrote ${relative(io.cwd, dir)}/${f}`);
    const result = runCodegen(dir, codegenConfig(io.cwd));
    const checked = await typecheck(dir, io.cwd, mode);
    if (!checked.ok) {
      io.err(checked.output);
      io.err("To ignore failing typecheck, use `--typecheck=disable`.");
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

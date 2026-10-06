// `bunvex codegen` (STUDY-36, STUDY-116): write the functions directory's `_generated/`, then typecheck.
// Convex's dynamic modes need nothing but the code, so no deployment is involved (G1): `--url` and
// `--admin-key` are accepted and ignored (DV-384). `--init` writes `tsconfig.json` and `README.md` first;
// `--dry-run` and `--debug` print instead of writing, as Convex's; `--commonjs` adds the CommonJS api.
import { relative } from "node:path";
import { argumentError, invalidChoice, missingArgument, optionsIn, tooManyArguments, unknownOption } from "./args.ts";
import {
  initFunctionsDir,
  printTypecheckFailure,
  runCodegen,
  type TypecheckMode,
  typecheck,
  type WriteMode,
} from "./codegen.ts";
import { codegenConfig, functionsDir, typescriptCompilerOf } from "./deploy.ts";
import type { Io } from "./io.ts";

// As Convex's help, which hides `--debug`, `--commonjs`, `--url` and `--admin-key`.
export const CODEGEN_USAGE = `Usage: bunvex codegen [options]

Generate the functions directory's _generated/ (api, server, dataModel), then typecheck the functions.

Options:
  --dry-run            print the files that would change instead of writing them
  --init               also write tsconfig.json and README.md in the functions directory
  --typecheck <mode>   enable, try (default) or disable`;

// Convex's flags for components: refused as `bunvex data --component` is (DV-385).
const COMPONENT_FLAGS = new Set(["--component-dir", "--live-component-sources"]);

export async function codegenCommand(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(CODEGEN_USAGE);
    return 0;
  }
  let init = false;
  let dryRun = false;
  let debug = false;
  let commonjs = false;
  let mode: TypecheckMode = "try";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    const value = () => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i]);
    if (a === "--init") init = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--debug") debug = true;
    else if (a === "--commonjs") commonjs = true;
    else if (COMPONENT_FLAGS.has(name)) {
      io.err(`bunvex codegen: ${name}: bunvex does not have components yet.`);
      return 2;
    } else if (name === "--url" || name === "--admin-key") {
      // Codegen reads no deployment (DV-173), so the deployment's flags change nothing (DV-384). Argument errors
      // as Convex's commander prints them; `codegen` shows no help after them.
      if (value() === undefined)
        return argumentError(io, missingArgument(name === "--url" ? "--url <url>" : "--admin-key <adminKey>"));
    } else if (name === "--typecheck") {
      const v = value();
      if (v === undefined) return argumentError(io, missingArgument("--typecheck <mode>"));
      if (v !== "enable" && v !== "try" && v !== "disable")
        return argumentError(io, invalidChoice("--typecheck <mode>", v, ["enable", "try", "disable"]));
      mode = v;
    } else if (a.startsWith("-")) return argumentError(io, unknownOption(a, optionsIn(CODEGEN_USAGE)));
    else return argumentError(io, tooManyArguments("codegen", 0, args.filter((x) => !x.startsWith("-")).length));
  }
  try {
    const dir = functionsDir(io.cwd);
    const config = codegenConfig(io.cwd);
    const write: WriteMode | undefined = dryRun || debug ? { dryRun, debug, cwd: io.cwd, out: io.out } : undefined;
    if (init) {
      const written = initFunctionsDir(dir, write);
      if (!write) for (const f of written) io.err(`Wrote ${relative(io.cwd, dir)}/${f}`);
    }
    const result = runCodegen(dir, { ...config, commonjs: commonjs || config.commonjs }, { mode: write });
    const checked = await typecheck(dir, io.cwd, mode, typescriptCompilerOf(io.cwd));
    if (!checked.ok) {
      printTypecheckFailure(io, checked);
      return 1;
    }
    if (checked.skipped && checked.skipped !== "disabled") io.err(checked.skipped);
    if (checked.warning) io.err(checked.warning);
    // A dry run's or a debug run's standard output is the files' lines alone, as Convex's.
    if (write) return 0;
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

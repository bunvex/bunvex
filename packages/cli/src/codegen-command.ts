// `bunvex codegen` (STUDY-36, STUDY-116): write the functions directory's `_generated/`, then typecheck.
// Convex's dynamic modes need nothing but the code, so no deployment is involved (G1): `--url` and
// `--admin-key` are accepted and ignored (DV-384). `--init` writes `tsconfig.json` and `README.md` first;
// `--dry-run` and `--debug` print instead of writing, as Convex's; `--commonjs` adds the CommonJS api.
//
// With components (STUDY-156): the definitions found and bundled as a push would, and analyzed here as the
// deployment would (`componentAnalysis`, DV-532), so `components` and each local component's `_generated/`
// are typed by their validators without a deployment. `--component-dir <dir>` generates one component's
// alone, mounted under an app of the CLI's as Convex's `exampleComponentInstance`; `--live-component-sources`
// resolves packages to their sources (DV-533).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { componentAnalysis } from "@bunvex/server";
import { argumentError, invalidChoice, missingArgument, optionsIn, tooManyArguments, unknownOption } from "./args.ts";
import {
  initFunctionsDir,
  printTypecheckFailure,
  runCodegen,
  type TypecheckMode,
  typecheck,
  type WriteMode,
} from "./codegen.ts";
import { type Analysis, appComponentEntries, componentCodegen } from "./component-codegen.ts";
import { bundleComponents, type Components, definitionFile, findComponents } from "./components.ts";
import { codegenConfig, functionsDir, typescriptCompilerOf } from "./deploy.ts";
import type { Io } from "./io.ts";
import { VERSION } from "./version.ts";

// As Convex's help, which hides `--debug`, `--commonjs`, `--url` and `--admin-key`.
export const CODEGEN_USAGE = `Usage: bunvex codegen [options]

Generate the functions directory's _generated/ (api, server, dataModel), then typecheck the functions.

Options:
  --dry-run            print the files that would change instead of writing them
  --init               also write tsconfig.json and README.md in the functions directory
  --typecheck <mode>   enable, try (default) or disable`;

/** The analysis a push of `found` would get, made here (DV-532). */
async function analyze(found: Components, project: string): Promise<Analysis> {
  const bundled = await bundleComponents(found, project);
  return (await componentAnalysis(
    bundled.app,
    bundled.components.map((c) => ({ ...c, udfServerVersion: VERSION })),
  )) as unknown as Analysis;
}

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
  let componentDir: string | undefined;
  let liveComponentSources = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    const value = () => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i]);
    if (a === "--init") init = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--debug") debug = true;
    else if (a === "--commonjs") commonjs = true;
    else if (a === "--live-component-sources") liveComponentSources = true;
    else if (name === "--component-dir") {
      const v = value();
      if (v === undefined) return argumentError(io, missingArgument("--component-dir <path>"));
      componentDir = v;
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
    if (componentDir !== undefined) return await oneComponent(resolve(io.cwd, componentDir), io, config, write, mode);
    const found = await findComponents(dir, { liveComponentSources });
    let components: string[] = [];
    if (found.graph) {
      // What the components' modules import to bundle, then their types from the analysis.
      if (!write) componentCodegen(found, config, null);
      const analysis = await analyze(found, io.cwd);
      components = appComponentEntries(found, analysis);
      componentCodegen(found, config, analysis, { mode: write });
    }
    const result = runCodegen(dir, { ...config, commonjs: commonjs || config.commonjs }, { mode: write, components });
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

/**
 * `--component-dir`: one component's `_generated/` alone, as Convex's: mounted as `exampleComponentInstance` by an
 * app of the CLI's, then typechecked in its directory.
 */
async function oneComponent(
  dir: string,
  io: Io,
  config: ReturnType<typeof codegenConfig>,
  write: WriteMode | undefined,
  mode: TypecheckMode,
): Promise<number> {
  const file = definitionFile(dir);
  if (!file?.endsWith(".ts")) {
    io.err(
      `bunvex codegen: Only directories with bunvex.config.ts files are supported, this directory does not: ${dir}`,
    );
    return 1;
  }
  const root = mkdtempSync(join(tmpdir(), "bunvex-component-dir-"));
  try {
    const appFile = join(root, "bunvex.config.ts");
    writeFileSync(
      appFile,
      `import { defineApp } from "${["bunvex", "server"].join("/")}";\nimport component from ${JSON.stringify(file)};\nconst app = defineApp();\napp.use(component, { name: "exampleComponentInstance" });\nexport default app;\n`,
    );
    const found = await findComponents(root, { appFile });
    // Every local definition's modules must bundle; only the component's own files are final.
    if (!write) componentCodegen(found, config, null);
    componentCodegen(found, config, await analyze(found, io.cwd), { mode: write, only: found.directories[0]?.dir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const checked = await typecheck(dir, io.cwd, mode, typescriptCompilerOf(io.cwd));
  if (!checked.ok) {
    printTypecheckFailure(io, checked);
    return 1;
  }
  if (checked.skipped && checked.skipped !== "disabled") io.err(checked.skipped);
  if (!write) io.out(`✔ Generated ${relative(io.cwd, dir)}/_generated`);
  return 0;
}

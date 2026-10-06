// `bunvex typecheck` (STUDY-117): Convex's `npx convex typecheck` — the app's compiler (`tsc`, or `tsgo` from
// `@typescript/native-preview`, by flag or bunvex.json), its arguments, and Convex's messages and exit codes.
// The real `tsc` for passing and failing projects; stand-in compilers (scripts that record their arguments)
// for which binary is chosen and how its answers are read.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main } from "../src/index.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};
const app = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-typecheck-"));
  dirs.push(d);
  write(d, files);
  return d;
};
const run = async (cwd: string, ...args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["typecheck", ...args], {
    env: {},
    cwd,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err };
};

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ESNext", noEmit: true },
  include: ["./**/*"],
});
const PASSED = "✔ Typecheck passed: `tsc --noEmit` completed with exit code 0.";
const UNABLE = "Unable to typecheck; is TypeScript installed?";

/** A project with the workspace's real TypeScript. */
const withTypescript = (files: Record<string, string>) => {
  const d = app({ "bunvex/tsconfig.json": TSCONFIG, ...files });
  mkdirSync(join(d, "node_modules"));
  symlinkSync(resolve(import.meta.dir, "../../../node_modules/typescript"), join(d, "node_modules/typescript"));
  return d;
};

/**
 * A stand-in compiler at `path`: it appends its arguments to `calls.json`, answers `--version` with `version`,
 * and otherwise prints `output` and exits with `code`.
 */
const fakeCompiler = (path: string, o: { version?: string; output?: string; code?: number; tag?: string } = {}) => ({
  [path]: `const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync("calls.json", JSON.stringify({ tag: ${JSON.stringify(o.tag ?? path)}, args }) + "\\n");
if (args[0] === "--version") { console.log("Version " + ${JSON.stringify(o.version ?? "6.0.2")}); process.exit(0); }
if (${JSON.stringify(o.output ?? "")}) console.log(${JSON.stringify(o.output ?? "")});
process.exit(${o.code ?? 0});`,
});
const calls = (d: string) =>
  readFileSync(join(d, "calls.json"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { tag: string; args: string[] })
    .filter((c) => c.args[0] !== "--version");

describe("bunvex typecheck, with the real tsc", () => {
  test("a project without errors passes: Convex's line on stderr, exit 0", async () => {
    const d = withTypescript({ "bunvex/a.ts": "export const x: number = 1;" });
    expect(await run(d)).toEqual({ code: 0, out: [], err: [PASSED] });
  }, 60_000);

  test("a type error: Convex's two lines on stderr, then the compiler's pretty errors on stdout, exit 1", async () => {
    const d = withTypescript({ "bunvex/a.ts": 'export const x: number = "one";' });
    const r = await run(d);
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["✖ TypeScript typecheck via `tsc` failed.", "Typecheck failed"]);
    expect(r.out).toHaveLength(1);
    // `--pretty true`: colors, and `file:line:column` from the project.
    expect(r.out[0]).not.toBe(Bun.stripANSI(r.out[0]!));
    expect(Bun.stripANSI(r.out[0]!)).toContain("bunvex/a.ts:1:14 - error TS2322");
  }, 60_000);
});

describe("bunvex typecheck, when it cannot run", () => {
  test("no TypeScript installed", async () => {
    const d = app({ "bunvex/tsconfig.json": TSCONFIG, "bunvex/a.ts": "export const x = 1;" });
    expect(await run(d)).toEqual({ code: 1, out: [], err: ["No `tsc` binary found, so skipping typecheck.", UNABLE] });
    expect((await run(d, "--typescript-compiler", "tsgo")).err).toEqual([
      "No `tsgo` binary found, so skipping typecheck.",
      UNABLE,
    ]);
  });

  test("no tsconfig.json", async () => {
    const d = app({ "bunvex/a.ts": "export const x = 1;" });
    expect(await run(d)).toEqual({
      code: 1,
      out: [],
      err: [
        "Found no bunvex/tsconfig.json to typecheck the functions with, so skipping typecheck. Run `bunvex codegen --init` to create one.",
        UNABLE,
      ],
    });
  });

  test("a bad --typescript-compiler or bunvex.json typescriptCompiler", async () => {
    const d = app({ "bunvex/tsconfig.json": TSCONFIG });
    // Argument errors as Convex's commander prints them (STUDY-124): `typecheck` shows no help after them.
    expect(await run(d, "--typescript-compiler", "swc")).toMatchObject({
      code: 1,
      err: [
        "error: option '--typescript-compiler <compiler>' argument 'swc' is invalid. Allowed choices are tsc, tsgo.",
      ],
    });
    expect(await run(d, "--typescript-compiler")).toMatchObject({
      code: 1,
      err: ["error: option '--typescript-compiler <compiler>' argument missing"],
    });
    expect(await run(d, "--watch")).toMatchObject({ code: 1, err: ["error: unknown option '--watch'"] });
    expect(await run(d, "--typescript-compilr", "tsc")).toMatchObject({
      code: 1,
      err: ["error: unknown option '--typescript-compilr'\n(Did you mean --typescript-compiler?)"],
    });
    expect(await run(d, "extra")).toMatchObject({
      code: 1,
      err: ["error: too many arguments for 'typecheck'. Expected 0 arguments but got 1."],
    });
    write(d, { "bunvex.json": '{"typescriptCompiler":"swc"}' });
    expect(await run(d)).toEqual({
      code: 1,
      out: [],
      err: [
        "bunvex typecheck: `typescriptCompiler` in `bunvex.json`: Invalid enum value. Expected 'tsc' | 'tsgo', received 'swc'",
      ],
    });
    write(d, { "bunvex.json": '{"typescriptCompiler":7}' });
    expect((await run(d)).err).toEqual([
      "bunvex typecheck: `typescriptCompiler` in `bunvex.json`: Expected 'tsc' | 'tsgo', received number",
    ]);
  });
});

describe("which compiler, and how it is run", () => {
  const TSGO = "node_modules/@typescript/native-preview/bin/tsgo";
  const TSC = "node_modules/typescript/bin/tsc";
  const NATIVE_TSC = "node_modules/@typescript/native/bin/tsc";

  test("tsgo from --typescript-compiler or bunvex.json; the flag wins; --noEmit --project <dir> --pretty true", async () => {
    const d = app({
      "bunvex/tsconfig.json": TSCONFIG,
      ...fakeCompiler(TSGO, { tag: "tsgo" }),
      ...fakeCompiler(`${TSGO}.js`, { tag: "tsgo.js" }),
      ...fakeCompiler(TSC, { tag: "tsc" }),
    });
    expect(await run(d, "--typescript-compiler=tsgo")).toEqual({
      code: 0,
      out: [],
      err: ["✔ Typecheck passed: `tsgo --noEmit` completed with exit code 0."],
    });
    // `bin/tsgo` before `bin/tsgo.js`, as Convex looks for them.
    expect(calls(d)).toEqual([{ tag: "tsgo", args: ["--noEmit", "--project", "bunvex", "--pretty", "true"] }]);
    write(d, { "bunvex.json": '{"typescriptCompiler":"tsgo","functions":"src/fns"}', "src/fns/tsconfig.json": "{}" });
    rmSync(join(d, TSGO));
    rmSync(join(d, "calls.json"));
    expect((await run(d)).err).toEqual(["✔ Typecheck passed: `tsgo --noEmit` completed with exit code 0."]);
    expect(await run(d, "--typescript-compiler", "tsc")).toEqual({ code: 0, out: [], err: [PASSED] });
    expect(calls(d).map((c) => [c.tag, c.args[2]])).toEqual([
      ["tsgo.js", "src/fns"],
      ["tsc", "src/fns"],
    ]);
  });

  test("tsc: @typescript/native's before typescript's", async () => {
    const d = app({
      "bunvex/tsconfig.json": TSCONFIG,
      ...fakeCompiler(NATIVE_TSC, { tag: "native" }),
      ...fakeCompiler(TSC, { tag: "tsc" }),
    });
    expect((await run(d)).code).toBe(0);
    expect(calls(d).map((c) => c.tag)).toEqual(["native"]);
  });

  test('"No inputs were found" (TS18003) passes, as Convex; any other failure fails', async () => {
    const d = app({
      "bunvex/tsconfig.json": TSCONFIG,
      ...fakeCompiler(TSC, {
        output: "\u001b[91merror\u001b[0m TS18003: No inputs were found in config file.",
        code: 2,
      }),
    });
    expect(await run(d)).toEqual({ code: 0, out: [], err: [PASSED] });
    write(d, fakeCompiler(TSC, { output: "error TS5023: Unknown compiler option.", code: 1 }));
    expect((await run(d)).out).toEqual(["error TS5023: Unknown compiler option."]);
  });

  test("an older TypeScript: Convex's warning after a codegen typecheck that passed; not from bunvex typecheck", async () => {
    const d = app({ "bunvex/tsconfig.json": TSCONFIG, "bunvex/a.ts": "", ...fakeCompiler(TSC, { version: "4.8.3" }) });
    const warning =
      "bunvex works best with TypeScript version 4.8.4 or newer -- npm i --save-dev typescript@latest to update.";
    const err: string[] = [];
    const codegen = await main(["codegen"], { env: {}, cwd: d, out: () => {}, err: (l) => err.push(l) });
    expect(codegen).toBe(0);
    expect(err).toEqual([warning]);
    expect(await run(d)).toEqual({ code: 0, out: [], err: [PASSED] });
    write(d, fakeCompiler(TSC, { version: "4.8.4" }));
    const newer: string[] = [];
    await main(["codegen"], { env: {}, cwd: d, out: () => {}, err: (l) => newer.push(l) });
    expect(newer).toEqual([]);
  });
});

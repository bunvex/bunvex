// `bunx @bunvex/auth` (STUDY-201 §1.18): upstream's `cli/init.test.ts` ported (each case on a real directory of its own
// rather than a stubbed file system), the arguments as commander answers them, the colors, and the files it writes
// checked end to end: typechecked by `bunvex codegen` and pushed to a deployment that answers their functions.
// biome-ignore-all lint/suspicious/noExplicitAny: the scaffolded app's api is untyped
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import {
  detectPackageManager,
  FILE_TEMPLATES,
  type InitIo,
  installCommand,
  type PackageManager,
  runInit,
} from "../src/cli/program.ts";

const PACKAGE_DIR = resolve(import.meta.dir, "..");
const ROOT = resolve(PACKAGE_DIR, "../..");
const dirs: string[] = [];
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
setDefaultTimeout(60_000);

/** An empty project directory, with these files. */
function project(files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bunvex-auth-init-")));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** Run the command in `dir` with no colors (unless `env` asks), its output captured. */
function run(dir: string, args: string[] = [], env: Record<string, string> = {}) {
  let out = "";
  let err = "";
  const io: InitIo = { cwd: dir, env, out: (t) => (out += t), err: (t) => (err += t), isTTY: false };
  const code = runInit(args, io);
  return { code, out, err };
}

const withAuth = JSON.stringify({ dependencies: { "@bunvex/auth": "^0.1.0" } });
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

describe("bunx @bunvex/auth", () => {
  test("fails with the install command when @bunvex/auth is missing, writing nothing", () => {
    const dir = project({ "package.json": JSON.stringify({ dependencies: {} }) });
    const { code, err } = run(dir, [], { npm_config_user_agent: "pnpm/9.0.0 npm/? node/v20" });
    expect(code).toBe(1);
    expect(err).toBe(
      "✖ @bunvex/auth is not a dependency of this project.\n\nInstall it, then run this command again:\n\n" +
        "    pnpm add @bunvex/auth\n\n",
    );
    expect(existsSync(join(dir, "bunvex"))).toBe(false);
  });

  test("fails when there is no package.json", () => {
    const dir = project();
    expect(run(dir)).toEqual({
      code: 1,
      out: "",
      err: `✖ No package.json found in ${dir}.\nRun this command from the root of your project.\n`,
    });
  });

  test("fails when package.json is not valid JSON, with the parser's message", () => {
    const dir = project({ "package.json": "{ not json" });
    const { code, err } = run(dir);
    expect(code).toBe(1);
    // Bun's parser gives no position, so no frame (DV-583).
    expect(err).toMatch(
      new RegExp(`^✖ Could not parse ${join(dir, "package.json")} as JSON\\.\n\n    JSON Parse error: .+\n$`),
    );
  });

  test("scaffolds every file, creating bunvex/", () => {
    const dir = project({ "package.json": withAuth });
    const { code, err } = run(dir);
    expect(code).toBe(0);
    expect(err).toBe("");
    for (const [name, content] of Object.entries(FILE_TEMPLATES)) expect(read(dir, `bunvex/${name}`)).toBe(content);
  });

  test("reports the run as one grouped summary", () => {
    const dir = project({ "package.json": withAuth });
    expect(run(dir).out).toBe(`bunvex auth setup in ${dir}

Files
  ✔ bunvex/auth.config.ts    created
  ✔ bunvex/bunvex.config.ts  created
  ✔ bunvex/auth.ts           created

Next steps
  1. Add a sign-in method — see the TODO comments in the new files.
  2. Start your dev server: bunx bunvex dev

  Docs: https://github.com/bunvex/bunvex/tree/main/components/auth#readme

`);
  });

  test("recognizes @bunvex/auth listed under devDependencies", () => {
    const dir = project({ "package.json": JSON.stringify({ devDependencies: { "@bunvex/auth": "^0.1.0" } }) });
    expect(run(dir).code).toBe(0);
    expect(existsSync(join(dir, "bunvex/auth.ts"))).toBe(true);
  });

  test("does not overwrite an existing file, but prints what it should contain", () => {
    const dir = project({ "package.json": withAuth, "bunvex/auth.ts": "// my hand-written auth.ts" });
    const { code, out, err } = run(dir);
    expect(code).toBe(0);
    expect(read(dir, "bunvex/auth.ts")).toBe("// my hand-written auth.ts");
    expect(out).toContain("  ! bunvex/auth.ts           already exists\n");
    // As it is, with no gutter, so it can be copied.
    expect(err).toBe(
      "\nbunvex/auth.ts already exists\n  This file was not changed. Make sure that it contains:\n\n" +
        FILE_TEMPLATES["auth.ts"],
    );
    // The other files were still written.
    expect(read(dir, "bunvex/bunvex.config.ts")).toBe(FILE_TEMPLATES["bunvex.config.ts"]);
  });

  test("a package.json of null fails as v2's does, on reading its dependencies", () => {
    const dir = project({ "package.json": "null" });
    expect(() => run(dir)).toThrow(TypeError);
  });
});

describe("arguments", () => {
  const HELP = `Usage: @bunvex/auth [options]

Set up bunvex auth in this project: scaffold the bunvex/ files.

Options:
  -h, --help  display help for command
`;

  test.each([["-h"], ["--help"], ["--foo --help"], ["init -h"]])("%s prints the help, writing nothing", (args) => {
    const dir = project({ "package.json": withAuth });
    expect(run(dir, args.split(" "))).toEqual({ code: 0, out: HELP, err: "" });
    expect(existsSync(join(dir, "bunvex"))).toBe(false);
  });

  test.each([
    ["--foo", "✖ unknown option '--foo'\n"],
    ["init --foo", "✖ unknown option '--foo'\n"],
    ["-x -y", "✖ unknown option '-x'\n"],
    ["-hx", "✖ unknown option '-hx'\n"],
    ["--hlep", "✖ unknown option '--hlep'\n(Did you mean --help?)\n"],
    ["--Help", "✖ unknown option '--Help'\n(Did you mean --help?)\n"],
    ["--help=1", "✖ unknown option '--help=1'\n(Did you mean --help?)\n"],
    // Two transpositions: 2 apart, where 4 substitutions would be too far.
    ["--ehpl", "✖ unknown option '--ehpl'\n(Did you mean --help?)\n"],
    ["--help=x=y", "✖ unknown option '--help=x=y'\n"],
    ["--h", "✖ unknown option '--h'\n"],
    ["-help", "✖ unknown option '-help'\n"],
    ["init", "✖ too many arguments. Expected 0 arguments but got 1.\n"],
    ["a b", "✖ too many arguments. Expected 0 arguments but got 2.\n"],
    ["-", "✖ too many arguments. Expected 0 arguments but got 1.\n"],
    ["-- -h", "✖ too many arguments. Expected 0 arguments but got 1.\n"],
  ])("%s is refused", (args, err) => {
    const dir = project({ "package.json": withAuth });
    expect(run(dir, args.split(" "))).toEqual({ code: 1, out: "", err });
  });

  test("a lone -- runs the command", () => {
    const dir = project({ "package.json": withAuth });
    expect(run(dir, ["--"]).code).toBe(0);
  });
});

describe("colors", () => {
  test("FORCE_COLOR colors the symbols, the titles and the code block's panel", () => {
    const dir = project({ "package.json": withAuth, "bunvex/auth.ts": "" });
    const { out, err } = run(dir, [], { FORCE_COLOR: "1" });
    expect(out).toContain("\x1b[1mbunvex auth\x1b[22m \x1b[2msetup in");
    expect(out).toContain("\x1b[32m✔\x1b[39m bunvex/auth.config.ts");
    expect(out).toContain("\x1b[33m!\x1b[39m bunvex/auth.ts");
    // Each row of the block on the dark panel, padded to the longest line plus two spaces a side.
    const rows = err.split("\n").filter((l) => l.startsWith("\x1b[48;5;235m"));
    const lines = FILE_TEMPLATES["auth.ts"].trimEnd().split("\n");
    expect(rows).toHaveLength(lines.length + 2);
    const width = Math.max(...lines.map((l) => l.length)) + 4;
    for (const row of rows) expect(Bun.stripANSI(row)).toHaveLength(width);
  });

  test("an error's symbol is red", () => {
    expect(run(project(), [], { FORCE_COLOR: "1" }).err).toStartWith("\x1b[31m✖\x1b[39m No package.json");
  });

  test.each([
    [{ FORCE_COLOR: "0" }, true],
    [{ NO_COLOR: "1" }, true],
    [{ TERM: "dumb" }, true],
    [{}, false],
  ])("no colors with %o (a terminal: %s)", (env, isTTY) => {
    let out = "";
    const io: InitIo = { cwd: project(), env, out: (t) => (out += t), err: (t) => (out += t), isTTY };
    runInit([], io);
    expect(out).not.toContain("\x1b[");
  });

  test("a terminal gets colors", () => {
    let err = "";
    runInit([], { cwd: project(), env: {}, out: () => {}, err: (t) => (err += t), isTTY: true });
    expect(err).toContain("\x1b[31m");
  });
});

describe("FILE_TEMPLATES", () => {
  // A new project's `bunvex/tsconfig.json` lists no `types`, so the files must not use Node's globals; a project with
  // `verbatimModuleSyntax` needs type-only imports as `import type`.
  test("auth.config.ts compiles without Node types", () => {
    expect(FILE_TEMPLATES["auth.config.ts"]).not.toContain("process.");
    expect(FILE_TEMPLATES["auth.config.ts"]).toContain('import type { AuthConfig } from "@bunvex/server";');
  });
});

describe("installCommand", () => {
  test.each([
    ["npm", "npm install @bunvex/auth"],
    ["pnpm", "pnpm add @bunvex/auth"],
    ["bun", "bun add @bunvex/auth"],
    ["yarn", "yarn add @bunvex/auth"],
    ["who-knows", "npm install @bunvex/auth"],
  ])("%s", (pm, command) => {
    expect(installCommand(pm)).toBe(command);
  });
});

describe("detectPackageManager", () => {
  test("prefers the agent that started the command", () => {
    expect(detectPackageManager("/nowhere", { npm_config_user_agent: "pnpm/9.0.0 npm/? node/v20" })).toBe("pnpm");
    expect(detectPackageManager("/nowhere", { npm_config_user_agent: "bun/1.4.4" })).toBe("bun");
    expect(detectPackageManager("/nowhere", { npm_config_user_agent: "yarn/4.0.0" })).toBe("yarn");
  });

  test.each<[string, PackageManager]>([
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["yarn.lock", "yarn"],
  ])("else the lockfile: %s", (lockfile, pm) => {
    expect(detectPackageManager(project({ [lockfile]: "" }), {})).toBe(pm);
  });

  test("falls back to npm with no signal", () => {
    expect(detectPackageManager("/nowhere", {})).toBe("npm");
  });
});

describe("the files it writes, end to end", () => {
  // A project with this package installed (linked, as `bun add` would) and TypeScript; the workspace's packages are
  // sources importing each other by `.ts` paths, so its tsconfig allows them, as the examples' do.
  function installedProject(): string {
    const dir = project({ "package.json": withAuth });
    const modules = join(dir, "node_modules");
    mkdirSync(join(modules, "@bunvex"), { recursive: true });
    symlinkSync(PACKAGE_DIR, join(modules, "@bunvex", "auth"));
    for (const p of ["server", "values"])
      symlinkSync(join(PACKAGE_DIR, "node_modules/@bunvex", p), join(modules, "@bunvex", p));
    symlinkSync(join(ROOT, "node_modules/typescript"), join(modules, "typescript"));
    return dir;
  }

  const bunvex = (dir: string, ...args: string[]) =>
    Bun.spawnSync([process.execPath, join(ROOT, "packages/cli/bin/bunvex.ts"), ...args], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1" },
    });

  test("the command, run as the package's bin, writes files that typecheck and push", async () => {
    const dir = installedProject();
    const bin = JSON.parse(read(PACKAGE_DIR, "package.json")).bin.auth;
    const init = Bun.spawnSync([process.execPath, join(PACKAGE_DIR, bin)], {
      cwd: dir,
      env: { ...process.env, npm_config_user_agent: "bun/1.4.4" },
    });
    expect(init.stderr.toString()).toBe("");
    expect(init.exitCode).toBe(0);

    // The functions' tsconfig, then the typecheck with it.
    expect(bunvex(dir, "codegen", "--init", "--typecheck", "disable").exitCode).toBe(0);
    const tsconfig = read(dir, "bunvex/tsconfig.json");
    expect(tsconfig).toContain('"noEmit": true');
    writeFileSync(
      join(dir, "bunvex/tsconfig.json"),
      tsconfig.replace('"noEmit": true', '"noEmit": true,\n    "allowImportingTsExtensions": true'),
    );
    const codegen = bunvex(dir, "codegen", "--typecheck", "enable");
    const printed = `${codegen.stdout}${codegen.stderr}`;
    expect(printed).not.toContain("skipping typecheck");
    expect(printed).not.toContain("error");
    expect(codegen.exitCode).toBe(0);

    const t = bunvexTest({ cwd: dir });
    open.push(t);
    const api = anyApi as any;
    expect(await t.query(api.auth.isAuthenticated, {})).toBe(false);
    expect(await t.mutation(api.auth.refreshSession, { refreshToken: "nope" })).toMatchObject({ kind: "noSession" });
  });
});

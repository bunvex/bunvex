// The auth package's command (STUDY-201 §1.18, C-8): Convex Auth v2's `npx @convex-dev/auth` at the pin (built from the
// reference clone by harness/convex-auth.ts, run with Node as npx runs it) and bunvex's `bunx @bunvex/auth` (run with
// Bun), in the same scenarios, each in a project directory of its own. It compares, byte for byte once the names are
// mapped (the package, the product, `convex/` to `bunvex/`, the dev command, the docs URL, the path) and each file's
// content replaced by the name of its template: the exit code, standard output and standard error, and the files left
// in the project. Not compared: a code block's colors and an unparsable `package.json`'s message past its first line
// (DV-583), and a `--` given first, which Bun takes before the command sees its arguments (DV-583). Local only:
// skipped, with a note, without a convex-auth clone to build the pin from.
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { convexAuthModules } from "../harness/convex-auth.ts";

const pin = convexAuthModules();
const ready = "modules" in pin;
if (!ready) console.warn(`auth init: skipped, ${(pin as { missing: string }).missing}`);
const V2_CLI = ready ? join(pin.modules, "@convex-dev/auth/dist/cli") : "";
const BUNVEX_CLI = resolve(import.meta.dir, "../../../components/auth/src/cli/init.ts");
const DOCS = "https://github.com/bunvex/bunvex/tree/main/components/auth#readme";

type Side = "convex" | "bunvex";
type Scenario = { files?: Record<string, string>; args?: string[]; env?: Record<string, string> };
type Outcome = { code: number | null; out: string; err: string; files: Record<string, string> };

const v2Templates: Record<string, string> = ready ? (await import(join(V2_CLI, "program.js"))).FILE_TEMPLATES : {};
// bunvex's templates, as its command writes them into an empty project.
const ours: Record<string, string> = ready ? writtenTemplates() : {};

function writtenTemplates(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "auth-init-templates-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@bunvex/auth": "1" } }));
    const p = Bun.spawnSync([process.execPath, BUNVEX_CLI], { cwd: dir, env: { PATH: process.env.PATH ?? "" } });
    if (p.exitCode !== 0) throw new Error(`bunx @bunvex/auth failed: ${p.stderr}`);
    const functions = join(dir, "bunvex");
    return Object.fromEntries(
      readdirSync(functions).map((name) => [name, readFileSync(join(functions, name), "utf8")]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Each side's files and their templates, named as bunvex names them.
const fileName = (side: Side, name: string) => (side === "convex" ? name.replaceAll("convex", "bunvex") : name);

function normalize(side: Side, text: string, dir: string): string {
  let t = text.replaceAll(dir, "<dir>");
  const templates = side === "convex" ? v2Templates : ours;
  // Longest first: a template's text without its last newline is a prefix of the whole.
  for (const [name, content] of Object.entries(templates)) {
    t = t.replaceAll(content, `<${fileName(side, name)}>\n`);
    t = t.replaceAll(content.trimEnd(), `<${fileName(side, name)}>`);
  }
  if (side === "bunvex") return t;
  return t
    .replaceAll("https://auth-v2.previews.convex.dev", DOCS)
    .replaceAll("@convex-dev/auth@beta", "@bunvex/auth")
    .replaceAll("@convex-dev/auth", "@bunvex/auth")
    .replaceAll("Convex Auth", "bunvex auth")
    .replaceAll("npx convex dev", "bunx bunvex dev")
    .replaceAll("convex.config.ts", "bunvex.config.ts")
    .replaceAll("convex/", "bunvex/");
}

function listFiles(dir: string, under = ""): string[] {
  return readdirSync(join(dir, under)).flatMap((name) => {
    const rel = under ? `${under}/${name}` : name;
    return statSync(join(dir, rel)).isDirectory() ? [`${rel}/`, ...listFiles(dir, rel)] : [rel];
  });
}

function runSide(side: Side, scenario: Scenario): Outcome {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `auth-init-${side}-`)));
  try {
    for (const [name, content] of Object.entries(scenario.files ?? {})) {
      const path = join(dir, side === "convex" ? name.replaceAll("bunvex", "convex") : name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content.replaceAll("@bunvex/auth", side === "convex" ? "@convex-dev/auth" : "@bunvex/auth"));
    }
    const cmd = side === "convex" ? ["node", join(V2_CLI, "init.js")] : [process.execPath, BUNVEX_CLI];
    const p = Bun.spawnSync([...cmd, ...(scenario.args ?? [])], {
      cwd: dir,
      // Nothing of the test's environment: no package manager's agent, no colors unless asked.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...scenario.env },
    });
    const files: Record<string, string> = {};
    for (const rel of listFiles(dir)) {
      const name = side === "convex" ? rel.replaceAll("convex", "bunvex") : rel;
      files[name] = rel.endsWith("/") ? "" : normalize(side, readFileSync(join(dir, rel), "utf8"), dir);
    }
    return {
      code: p.exitCode,
      out: normalize(side, p.stdout.toString(), dir),
      err: normalize(side, p.stderr.toString(), dir),
      files,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const withAuth = JSON.stringify({ dependencies: { "@bunvex/auth": "^1.0.0" } });

const SCENARIOS: Record<string, Scenario> = {
  "no package.json": {},
  "not a dependency, npm by default": { files: { "package.json": "{}" } },
  "not a dependency, pnpm's agent": {
    files: { "package.json": "{}" },
    env: { npm_config_user_agent: "pnpm/9.0.0 npm/? node/v20" },
  },
  "not a dependency, bun's lockfile": { files: { "package.json": "{}", "bun.lock": "" } },
  "not a dependency, yarn's lockfile": { files: { "package.json": "{}", "yarn.lock": "" } },
  "an array as package.json": { files: { "package.json": "[]" } },
  "the files written": { files: { "package.json": withAuth } },
  "a devDependency": { files: { "package.json": JSON.stringify({ devDependencies: { "@bunvex/auth": "1" } }) } },
  "the functions directory exists": { files: { "package.json": withAuth, "bunvex/users.ts": "// mine" } },
  "auth.ts exists": { files: { "package.json": withAuth, "bunvex/auth.ts": "// mine" } },
  "every file exists": {
    files: {
      "package.json": withAuth,
      "bunvex/auth.config.ts": "// a",
      "bunvex/bunvex.config.ts": "// b",
      "bunvex/auth.ts": "// c",
    },
  },
  "colors, the files written": { files: { "package.json": withAuth }, env: { FORCE_COLOR: "1" } },
  "colors, an error": { env: { FORCE_COLOR: "1" } },
  "colors, the install command": { files: { "package.json": "{}" }, env: { FORCE_COLOR: "1" } },
  NO_COLOR: { files: { "package.json": withAuth }, env: { NO_COLOR: "1" } },
};
for (const args of [
  "-h",
  "--help",
  "--foo --help",
  "init -h",
  "--foo",
  "init --foo",
  "-x -y",
  "-hx",
  "--hlep",
  "--ehpl",
  "--Help",
  "--h",
  "--help=1",
  "--help=x=y",
  "-help",
  "init",
  "a b",
  "-",
  "init -- -h",
  "--",
])
  SCENARIOS[`arguments: ${args}`] = { files: { "package.json": withAuth }, args: args.split(" ") };

describe.skipIf(!ready)("the auth package's command, v2's and bunvex's", () => {
  test.each(Object.keys(SCENARIOS))("%s", (name) => {
    const scenario = SCENARIOS[name]!;
    expect(runSide("bunvex", scenario)).toEqual(runSide("convex", scenario));
  });

  test("an unparsable package.json: the same first line and exit code", () => {
    const scenario = { files: { "package.json": "{ not json" } };
    const [v2, ours] = [runSide("convex", scenario), runSide("bunvex", scenario)];
    expect(ours.code).toBe(v2.code);
    expect(ours.out).toBe(v2.out);
    expect(ours.err.split("\n").slice(0, 2)).toEqual(v2.err.split("\n").slice(0, 2));
    expect(ours.files).toEqual(v2.files);
  });

  test("a package.json of null: both fail", () => {
    const scenario = { files: { "package.json": "null" } };
    expect(runSide("bunvex", scenario).code).toBe(runSide("convex", scenario).code);
  });
});

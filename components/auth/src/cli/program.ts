// `bunx @bunvex/auth` (STUDY-201 §1.18, C-8), v2's `npx @convex-dev/auth` (`cli/program.ts`) in bunvex's words: it
// checks that the project in the current directory depends on the package (it installs nothing: it prints the install
// command for the package manager in use), then writes `bunvex/auth.config.ts`, `bunvex/bunvex.config.ts` and
// `bunvex/auth.ts`, never over an existing file, whose expected content it prints instead. Like v2's, it writes to
// `bunvex/` whatever `bunvex.json` names as the functions directory. v2 parses its arguments with commander; bunvex parses
// them itself, to the same help, errors and suggestions (commander 14's `--help`, unknown options, excess arguments), and
// writes its output through `output.ts` (DV-583).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { colorEnabled, makeOutput, type Output } from "./output.ts";

const PACKAGE = "@bunvex/auth";
const DOCS_URL = "https://github.com/bunvex/bunvex/tree/main/components/auth#readme";

/** The files the command writes into `bunvex/`, in the order it writes them. */
export const FILE_TEMPLATES = {
  "auth.config.ts": `import type { AuthConfig } from "@bunvex/server";
import { bunvexAuthProvider } from "@bunvex/auth/server";

export default {
  providers: [bunvexAuthProvider()],
} satisfies AuthConfig;
`,
  "bunvex.config.ts": `import { defineApp } from "@bunvex/server";
import auth from "@bunvex/auth/bunvex.config.js";

const app = defineApp();

app.use(auth);
// TODO Mount the components of your sign-in methods

export default app;
`,
  "auth.ts": `import { components } from "./_generated/api";
import { setupAuth } from "@bunvex/auth/server";

const auth = setupAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

// TODO Set up a sign-in method, for instance username + password:
// export const { signUpWithUsernamePassword, signInWithUsernamePassword } =
//   setupUsernamePassword(auth, {
//     component: components.authPassword,
//     usernameComponent: components.authUsername,
//   }).attachUserCallbacks({ createUser: internal.users.createUser });
`,
};

const HELP = `Usage: ${PACKAGE} [options]

Set up bunvex auth in this project: scaffold the bunvex/ files.

Options:
  -h, --help  display help for command
`;

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** The command that adds the package to a project, for a package manager (npm's for one it does not know). */
export function installCommand(packageManager: string): string {
  switch (packageManager) {
    case "pnpm":
      return `pnpm add ${PACKAGE}`;
    case "bun":
      return `bun add ${PACKAGE}`;
    case "yarn":
      return `yarn add ${PACKAGE}`;
    default:
      return `npm install ${PACKAGE}`;
  }
}

/**
 * The package manager in use: the one that started the command (`npm_config_user_agent`), else the one whose lockfile
 * is in `dir`, else npm.
 */
export function detectPackageManager(dir: string, env: Record<string, string | undefined>): PackageManager {
  const agent = env.npm_config_user_agent ?? "";
  for (const pm of ["pnpm", "bun", "yarn", "npm"] as const) if (agent.startsWith(pm)) return pm;
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** Where the command runs and writes: the process's by default; tests give their own. */
export type InitIo = {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Standard output and standard error, written as they are (each message ends with its own newline). */
  out: (text: string) => void;
  err: (text: string) => void;
  /** Whether standard output is a terminal: colors follow it, as for every message of the command. */
  isTTY: boolean;
};

export const processIo = (): InitIo => ({
  cwd: process.cwd(),
  env: process.env,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  isTTY: !!process.stdout.isTTY,
});

// Commander's suggestion for a mistyped `--` option: the candidates within an optimal-string-alignment distance of 3
// and more than 40% alike, the closest kept. This command has one, `--help`.
function suggestion(flag: string): string {
  if (!flag.startsWith("--")) return "";
  const word = flag.slice(2);
  const candidate = "help";
  const distance = editDistance(word, candidate);
  const length = Math.max(word.length, candidate.length);
  return distance <= 3 && (length - distance) / length > 0.4 ? "\n(Did you mean --help?)" : "";
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[a.length]![b.length]!;
}

type Args = { help: true } | { help: false; unknown: string | null; extra: number };

// `-h`/`--help` anywhere before `--` wins; then the first unknown option; then any argument (`-` and all after `--`
// are arguments).
function parseArgs(argv: string[]): Args {
  let unknown: string | null = null;
  let extra = 0;
  let options = true;
  for (const arg of argv) {
    if (options && arg === "--") options = false;
    else if (options && (arg === "-h" || arg === "--help")) return { help: true };
    else if (options && arg.startsWith("-") && arg !== "-") unknown ??= arg;
    else extra++;
  }
  return { help: false, unknown, extra };
}

type PackageJson = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const hasAuthDependency = (pkg: PackageJson) =>
  PACKAGE in (pkg.dependencies ?? {}) || PACKAGE in (pkg.devDependencies ?? {});

/** Run the command with these arguments (after the command's name); it returns the exit code. */
export function runInit(argv: string[], io: InitIo = processIo()): number {
  const o = makeOutput(colorEnabled(io.env, io.isTTY));
  const fail = (message: string) => {
    io.err(`${o.symbols.failed} ${message}\n`);
    return 1;
  };

  const args = parseArgs(argv);
  if (args.help) {
    io.out(HELP);
    return 0;
  }
  if (args.unknown !== null) return fail(`unknown option '${args.unknown}'${suggestion(args.unknown)}`);
  if (args.extra > 0) return fail(`too many arguments. Expected 0 arguments but got ${args.extra}.`);

  const dir = io.cwd;
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath))
    return fail(`No package.json found in ${dir}.\nRun this command from the root of your project.`);
  const source = readFileSync(pkgPath, "utf8");
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Could not parse ${pkgPath} as JSON.\n\n${indent(message)}`);
  }
  if (!hasAuthDependency(pkg))
    return fail(
      `${PACKAGE} is not a dependency of this project.\n\nInstall it, then run this command again:\n\n` +
        `${o.command(installCommand(detectPackageManager(dir, io.env)))}\n`,
    );

  const log = (line: string) => io.out(`${line}\n`);
  log(`${o.bold("bunvex auth")} ${o.dim(`setup in ${dir}`)}`);
  reportFiles(io, o, writeAuthFiles(dir));
  log(o.heading("Next steps"));
  log(o.step(1, "Add a sign-in method — see the TODO comments in the new files."));
  log(o.step(2, `Start your dev server: ${o.cyan("bunx bunvex dev")}`));
  log(`\n  ${o.dim("Docs:")} ${DOCS_URL}\n`);
  return 0;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `    ${line}` : line))
    .join("\n");
}

type FileOutcome = { name: keyof typeof FILE_TEMPLATES; created: boolean };

// Writes each template into `bunvex/` (made if absent), leaving a file that exists as it is.
function writeAuthFiles(dir: string): FileOutcome[] {
  const functionsDir = join(dir, "bunvex");
  if (!existsSync(functionsDir)) mkdirSync(functionsDir, { recursive: true });
  return (Object.keys(FILE_TEMPLATES) as (keyof typeof FILE_TEMPLATES)[]).map((name) => {
    const path = join(functionsDir, name);
    if (existsSync(path)) return { name, created: false };
    writeFileSync(path, FILE_TEMPLATES[name]);
    return { name, created: true };
  });
}

// One aligned line per file, then, on standard error, what each file that was there should contain: after the list,
// so as not to break it up.
function reportFiles(io: InitIo, o: Output, outcomes: FileOutcome[]): void {
  const width = "bunvex/".length + Math.max(...outcomes.map(({ name }) => name.length));
  io.out(`${o.heading("Files")}\n`);
  for (const { name, created } of outcomes) {
    const label = `bunvex/${name}`.padEnd(width);
    io.out(
      `${created ? o.item(o.symbols.done, `${label}  ${o.dim("created")}`) : o.item(o.symbols.skipped, `${label}  ${o.dim("already exists")}`)}\n`,
    );
  }
  for (const { name, created } of outcomes) {
    if (created) continue;
    io.err(`${o.heading(`bunvex/${name} already exists`)}\n`);
    io.err("  This file was not changed. Make sure that it contains:\n\n");
    io.err(`${o.codeBlock(FILE_TEMPLATES[name])}\n`);
  }
}

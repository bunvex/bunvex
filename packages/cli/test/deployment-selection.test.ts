// Which deployment a command acts on (STUDY-65 G-L4), as Convex's CLI chooses it
// (cli/lib/deploymentSelection.ts, its self-hosted and local cases in deploymentSelection.test.ts):
// - `--url` with `--admin-key` wins, and only both together count;
// - otherwise the environment, then `.env.local`, then `.env`, each filling only what is still unset; an empty
//   value is no value;
// - `--env-file` replaces all three (it must exist and name a deployment);
// - the self-hosted variables and `BUNVEX_DEPLOYMENT` may not be set together.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index.ts";
import type { Io } from "../src/io.ts";
import { configuredDeployment } from "../src/local-deployment.ts";
import { resolveTarget } from "../src/target.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function project(files: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), "bunvex-select-"));
  dirs.push(d);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(d, f), text);
  return d;
}
const io = (cwd: string, env: Record<string, string | undefined> = {}): Io => ({
  env,
  cwd,
  out: () => {},
  err: () => {},
});
const URL_VAR = "BUNVEX_SELF_HOSTED_URL";
const KEY_VAR = "BUNVEX_SELF_HOSTED_ADMIN_KEY";
const msg = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
};

test("--url with --admin-key wins over everything; one of them alone does not count", () => {
  const dir = project({ ".env.local": `${URL_VAR}=http://file\n${KEY_VAR}=file-key\n` });
  const env = { [URL_VAR]: "http://env", [KEY_VAR]: "env-key" };
  expect(resolveTarget({ url: "http://flag/", adminKey: "flag-key" }, io(dir, env))).toEqual({
    url: "http://flag",
    adminKey: "flag-key",
  });
  expect(resolveTarget({ url: "http://flag" }, io(dir, env))).toEqual({ url: "http://env", adminKey: "env-key" });
  expect(resolveTarget({ adminKey: "flag-key" }, io(dir))).toEqual({ url: "http://file", adminKey: "file-key" });
});

test("the environment, then .env.local, then .env, variable by variable", () => {
  const dir = project({
    ".env.local": `${URL_VAR}=http://local\n`,
    ".env": `${URL_VAR}=http://dotenv\n${KEY_VAR}=dotenv-key\n`,
  });
  expect(resolveTarget({}, io(dir))).toEqual({ url: "http://local", adminKey: "dotenv-key" });
  expect(resolveTarget({}, io(dir, { [KEY_VAR]: "env-key" }))).toEqual({ url: "http://local", adminKey: "env-key" });
  expect(resolveTarget({}, io(dir, { [URL_VAR]: "http://env" }))).toEqual({
    url: "http://env",
    adminKey: "dotenv-key",
  });
  // Set but empty: the files do not fill it (dotenv does not override), and empty counts as unset.
  expect(resolveTarget({}, io(dir, { [URL_VAR]: "" }))).toBeNull();
});

test("--env-file alone: the environment and the project's files are not read", () => {
  const dir = project({
    ".env.local": `${URL_VAR}=http://local\n${KEY_VAR}=local-key\n`,
    "prod.env": `${URL_VAR}=http://prod\n${KEY_VAR}=prod-key\n`,
    "half.env": `${URL_VAR}=http://prod\n`,
    "local.env": "BUNVEX_DEPLOYMENT=local:mine\n",
  });
  const env = { [URL_VAR]: "http://env", [KEY_VAR]: "env-key" };
  expect(resolveTarget({ envFile: "prod.env" }, io(dir, env))).toEqual({ url: "http://prod", adminKey: "prod-key" });
  expect(msg(() => resolveTarget({ envFile: "missing.env" }, io(dir, env)))).toBe("env file does not exist");
  expect(msg(() => resolveTarget({ envFile: "half.env" }, io(dir, env)))).toBe(
    "env file `half.env` did not contain environment variables for a bunvex deployment. Expected `BUNVEX_DEPLOYMENT`, or both `BUNVEX_SELF_HOSTED_URL` and `BUNVEX_SELF_HOSTED_ADMIN_KEY` to be set.",
  );
  // A local deployment named by the file: no self-hosted target, and the file's BUNVEX_DEPLOYMENT is the one.
  expect(resolveTarget({ envFile: "local.env" }, io(dir, env))).toBeNull();
  expect(configuredDeployment(io(dir, { BUNVEX_DEPLOYMENT: "local:other" }), { envFile: "local.env" })).toEqual({
    type: "local",
    name: "mine",
  });
});

test("the self-hosted variables and BUNVEX_DEPLOYMENT may not be set together", () => {
  const dir = project();
  expect(
    msg(() => resolveTarget({}, io(dir, { [URL_VAR]: "http://x", [KEY_VAR]: "k", BUNVEX_DEPLOYMENT: "local:y" }))),
  ).toBe("BUNVEX_DEPLOYMENT must not be set when BUNVEX_SELF_HOSTED_URL and BUNVEX_SELF_HOSTED_ADMIN_KEY are set");
  expect(msg(() => resolveTarget({}, io(dir, { [URL_VAR]: "http://x", BUNVEX_DEPLOYMENT: "local:y" })))).toBe(
    "BUNVEX_SELF_HOSTED_URL and BUNVEX_SELF_HOSTED_ADMIN_KEY must not be set when BUNVEX_DEPLOYMENT is set",
  );
});

test("a command reports the problem and stops", async () => {
  const dir = project();
  const err: string[] = [];
  const it: Io = { env: {}, cwd: dir, out: () => {}, err: (l) => err.push(l) };
  expect(await main(["env", "list", "--env-file", "missing.env"], it)).toBe(1);
  expect(err).toEqual(["bunvex env: env file does not exist"]);
});

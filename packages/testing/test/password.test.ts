// `@bunvex/server/password` (AD-49, STUDY-201 C-2) on a deployment, in-process and under the process sandbox (where
// the child asks the host): the `authPassword` component's mutations hash and verify, with the salt from their seeded
// stream; any other function, the app's, another component's or that component's query, is refused with the same
// error in both runtimes.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi, componentsGeneric } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "../src/index.ts";

const APP = join(import.meta.dir, "fixtures", "password", "app");
const components = componentsGeneric() as typeof anyApi;
const lib = components.authPassword.lib;
const PHC = /^\$argon2id\$v=19\$m=16384,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;
const REFUSED = "can only be called from a mutation of the authPassword component";

const open: TestBunvex[] = [];
const saved = {
  sandbox: process.env.BUNVEX_FUNCTION_SANDBOX,
  isolation: process.env.BUNVEX_FUNCTION_SANDBOX_ISOLATION,
};
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
  for (const [name, value] of [
    ["BUNVEX_FUNCTION_SANDBOX", saved.sandbox],
    ["BUNVEX_FUNCTION_SANDBOX_ISOLATION", saved.isolation],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

describe.each(["in-process", "process sandbox"] as const)("%s", (mode) => {
  const deployment = () => {
    if (mode === "process sandbox") {
      process.env.BUNVEX_FUNCTION_SANDBOX = "process";
      process.env.BUNVEX_FUNCTION_SANDBOX_ISOLATION = "none";
    }
    const t = bunvexTest({ cwd: APP });
    open.push(t);
    return t;
  };

  test("authPassword's mutations hash and verify; each salt is new", async () => {
    const t = deployment();
    const a = (await t.mutation(lib.hash, { password: "correct horse" })) as string;
    const b = (await t.mutation(lib.hash, { password: "correct horse" })) as string;
    expect(a).toMatch(PHC);
    expect(b).toMatch(PHC);
    expect(a).not.toBe(b);
    expect(await t.mutation(lib.verify, { password: "correct horse", hash: a })).toBe(true);
    expect(await t.mutation(lib.verify, { password: "correct horsf", hash: a })).toBe(false);
    // Called from the app, the component's mutation still hashes: the scope is the running function's.
    expect(await t.mutation(anyApi.calls.throughComponent)).toMatch(PHC);
  }, 30_000);

  test("several at once, side by side", async () => {
    const t = deployment();
    const hashes = (await t.mutation(lib.hashMany, { count: 8 })) as string[];
    expect(new Set(hashes).size).toBe(8);
    for (const h of hashes) expect(h).toMatch(PHC);
  }, 30_000);

  test("anyone else is refused: the app, another component, authPassword's own query", async () => {
    const t = deployment();
    await expect(t.mutation(anyApi.calls.appHash)).rejects.toThrow(`hashPassword ${REFUSED}`);
    await expect(t.mutation(components.other.lib.hash)).rejects.toThrow(`hashPassword ${REFUSED}`);
    await expect(t.query(lib.hashInQuery)).rejects.toThrow(`hashPassword ${REFUSED}`);
  }, 30_000);

  test("a salt under 8 bytes is refused", async () => {
    const t = deployment();
    await expect(t.mutation(lib.shortSalt)).rejects.toThrow("hashPassword: the salt must be 8 bytes or more");
  }, 30_000);
});

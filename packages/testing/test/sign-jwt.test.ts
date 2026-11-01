// `ctx.auth.signJwt` across the function runtimes (STUDY-192 §5): the app's token and its component's (whose `iss`
// names the component's path), in-process and under the process sandbox (AD-44), where the child asks the host to
// sign and never holds the key (DV-579). Both give the same claims, and `iat` is the mutation's own time.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "../src/index.ts";

const APP = join(import.meta.dir, "fixtures", "app-with-component");
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

const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());

describe.each(["in-process", "process sandbox"] as const)("signJwt, %s", (mode) => {
  test("the app signs as the deployment, its component under /components/<path>; iat is the mutation's time", async () => {
    if (mode === "process sandbox") {
      process.env.BUNVEX_FUNCTION_SANDBOX = "process";
      process.env.BUNVEX_FUNCTION_SANDBOX_ISOLATION = "none";
    }
    const t = bunvexTest({ cwd: APP });
    open.push(t);
    const { app, component, now } = (await t.mutation(anyApi.visits.tokens)) as {
      app: string;
      component: string;
      now: number;
    };
    const a = payloadOf(app);
    const c = payloadOf(component);
    expect(a.sub).toBe("app");
    expect(c.sub).toBe("counter");
    expect(c.iss).toBe(`${a.iss}/components/counter`);
    expect(a.iat).toBe(Math.floor(now / 1000));
    expect(a.exp).toBe(a.iat + 60);
    expect(c.iat).toBe(a.iat);
  }, 30_000);
});

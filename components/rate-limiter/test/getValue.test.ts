// Upstream's `src/component/getValue.test.ts` (get-convex/rate-limiter 0.4.2, STUDY-197 §1.7), ported: `getValue`
// for both kinds, unused, sampled across shards, and after a consumption, on the component's functions pushed as the
// app's (fixtures/standalone).
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx and the app's api are untyped
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";

const api = anyApi as any;
const SECOND = 1_000;
const STANDALONE = join(import.meta.dir, "fixtures", "standalone");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
function deployment() {
  const t = bunvexTest({ cwd: STANDALONE });
  open.push(t);
  return t;
}

describe.each(["token bucket", "fixed window"] as const)("getValue %s", (kind) => {
  test("an unused limit: full, with the defaults filled in", async () => {
    const t = deployment();
    const config = { kind, rate: 10, period: SECOND };
    const result = await t.run((ctx: any) => ctx.runQuery(api.lib.getValue, { name: "unused", config }));
    expect(result.value).toBe(10);
    expect(result.ts).toBeDefined();
    expect(result.config).toMatchObject({ ...config, capacity: config.rate, shards: 1 });
    // A fixed window gets the start of the window it computed; a token bucket has none.
    if (kind === "fixed window") expect(result.config.start).toBeDefined();
    else expect(result.config.kind).toBe("token bucket");
  });

  test("with sampleShards", async () => {
    const t = deployment();
    const config = { kind, rate: 10, period: SECOND, shards: 5 };
    const result = await t.run((ctx: any) =>
      ctx.runQuery(api.lib.getValue, { name: "sharded", config, sampleShards: 3 }),
    );
    expect(result.value).toBe(10);
    const { start, ...rest } = result.config;
    if (kind === "fixed window") expect(typeof start).toBe("number");
    else expect(start).toBeFalsy();
    expect(rest).toMatchObject({ ...config, capacity: config.rate });
  });

  test("after a consumption", async () => {
    const t = deployment();
    const config = { kind, rate: 10, period: SECOND };
    const result = await t.run(async (ctx: any) => {
      await ctx.runMutation(api.lib.rateLimit, { name: "consumed", config, count: 4 });
      return ctx.runQuery(api.lib.getValue, { name: "consumed", config });
    });
    expect(result.value).toBe(6);
    expect(result.config).toMatchObject({ ...config, capacity: config.rate });
  });
});

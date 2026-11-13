// The anonymous component's suite (STUDY-201 §3.4), upstream's `components/anonymous/anonymous.test.ts` at v2.0.0 ported: its
// function pushed as an app's (fixtures/anonymous).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";

// biome-ignore lint/suspicious/noExplicitAny: the app's api is untyped
const api = anyApi as any;
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
// Each test pushes a deployment of its own; under a full `bun run check` a push can take past the default 5 s.
setDefaultTimeout(60_000);

function setup(): TestBunvex {
  const t = bunvexTest({ cwd: join(import.meta.dir, "fixtures", "anonymous") });
  open.push(t);
  return t;
}

describe("anonymous auth", () => {
  test("createAnonymousAccount records the user", async () => {
    const t = setup();
    expect(await t.mutation(api.provider.createAnonymousAccount, { userId: "user-1" })).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: the inline function's ctx is untyped
    const accounts = await t.run(async (ctx: any) => await ctx.db.query("accounts").collect());
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ userId: "user-1" });
  });
});

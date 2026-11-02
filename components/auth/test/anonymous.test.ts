// The anonymous component's suite (STUDY-201 §3.4), upstream's `components/anonymous/anonymous.test.ts` ported: its
// function pushed as an app's (fixtures/anonymous).
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";

// biome-ignore lint/suspicious/noExplicitAny: the app's api is untyped
const api = anyApi as any;
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});

function setup(): TestBunvex {
  const t = bunvexTest({ cwd: join(import.meta.dir, "fixtures", "anonymous") });
  open.push(t);
  return t;
}

describe("anonymous auth", () => {
  test("createAnonymousAccount, returns ID", async () => {
    const t = setup();
    const result = await t.mutation(api.provider.createAnonymousAccount, {});
    expect(result).not.toBe(null);
    // A UUID, stored as the account's id.
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // biome-ignore lint/suspicious/noExplicitAny: the inline function's ctx is untyped
    const rows = await t.run(async (ctx: any) => await ctx.db.query("accounts").collect());
    expect(rows.map((r: { anonymousId: string }) => r.anonymousId)).toEqual([result]);
  });
});

// Components in `bunvexTest` (STUDY-159 PR 3): an app's own components, installed as its push installs them, and a
// component package's own tests (`registerComponent`, as convex-test's `register(t, name)` helpers call it).
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi, componentsGeneric } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "../src/index.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
const make = (cwd?: string) => {
  const t = bunvexTest(cwd === undefined ? {} : { cwd });
  open.push(t);
  return t;
};

describe("components", () => {
  test("an app's components are installed by its push; the app calls them, and so may the test", async () => {
    const t = make(join(FIXTURES, "app-with-component"));
    await t.mutation(anyApi.visits.visit);
    await t.mutation(anyApi.visits.visit);
    expect(await t.query(anyApi.visits.visits)).toBe(2);
    const counter = (componentsGeneric() as Record<string, any>).counter;
    expect(await t.query(counter.lib.count, { name: "visits" })).toBe(2);
  });

  test("registerComponent: a component package's own tests call it through its reference", async () => {
    const t = make(join(FIXTURES, "nothing-here"));
    const counter = t.registerComponent("counter", join(FIXTURES, "counter"));
    await t.mutation(counter.lib.add, { name: "a", by: 2 });
    await t.mutation(counter.lib.add, { name: "a" });
    expect(await t.query(counter.lib.count, { name: "a" })).toBe(3);
    expect(await t.query(counter.lib.count, { name: "b" })).toBe(0);
  });

  test("a component registered under another name is mounted under it", async () => {
    const t = make(join(FIXTURES, "nothing-here"));
    const c = t.registerComponent("other", join(FIXTURES, "counter", "bunvex.config.ts"));
    await t.mutation(c.lib.add, { name: "x" });
    expect(await t.query(c.lib.count, { name: "x" })).toBe(1);
  });

  test("registerComponent after the first call is refused", async () => {
    const t = make(join(FIXTURES, "app"));
    await t.query(anyApi.messages.list);
    expect(() => t.registerComponent("counter", join(FIXTURES, "counter"))).toThrow(
      "bunvexTest: registerComponent must come before the first call",
    );
  });
});

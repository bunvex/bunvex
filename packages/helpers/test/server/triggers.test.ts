// convex-helpers' `server/triggers.test.ts` (e48f9df) ported to bunvex (STUDY-181 PR 5). Upstream defines the
// functions in the test module and runs them on convex-test; here they are a project (fixtures/triggers) pushed by
// `@bunvex/testing`'s `bunvexTest`, so each call goes through the engine as an app's does.
//
// Where it differs from upstream:
// - A trigger's write with an id of another table fails with bunvex's message, which is Convex's backend's
//   (`isolate/src/environment/helpers/mod.rs`), where convex-test words it "Invalid argument `id`, expected ID in table
//   'users' but got ID in table '…'". Both come from the trigger path's first read, `db.get`.
// - That wrong-table patch is not a type error here (upstream's `@ts-expect-error`): bunvex's `GenericDatabaseWriter`
//   does not type the id `GenericId<NonUnion<TableName>>` as Convex's does (see the fixture).
// - The `this` test wraps the database in the fixture's `GuardedWriter`, not `rowLevelSecurity`'s
//   `wrapDatabaseWriter` (not ported yet).
// - Added: the trigger's `ctx` and the pass-throughs, the order recursive triggers run in, the first error thrown
//   after the drain with the others logged, and two mutations at once (DV-545).
// biome-ignore-all lint/suspicious/noExplicitAny: the ported tests use `any` as convex-helpers' do
import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { anyApi, type DataModelFromSchemaDefinition } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { type Change, DatabaseWriterWithTriggers, Triggers, writerWithTriggers } from "../../src/server/triggers.ts";
import type schema from "../fixtures/triggers/bunvex/schema.ts";

const APP = join(import.meta.dir, "..", "fixtures", "triggers");
const api = anyApi.triggers as any;
type DataModel = DataModelFromSchemaDefinition<typeof schema>;

const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
const make = () => {
  const t = bunvexTest({ cwd: APP });
  open.push(t);
  return t;
};

test("trigger denormalizes field", async () => {
  const t = make();
  const userId = await t.mutation(api.createUser, { firstName: "John", lastName: "Doe" });
  await t.run(async (ctx) => {
    const user = await ctx.db.get(userId);
    expect(user.fullName).toStrictEqual("John Doe");
  });
});

test("trigger with explicit IDs denormalizes field", async () => {
  const t = make();
  const userId = await t.mutation(api.createUserExplicit, { firstName: "John", lastName: "Doe" });
  await t.run(async (ctx) => {
    const user = await ctx.db.get("usersExplicit", userId);
    expect(user.fullName).toStrictEqual("John Doe");
  });
});

test("trigger with wrong usage of explicit IDs fails", async () => {
  const t = make();
  await expect(
    t.mutation(api.createUserExplicitIncorrectTable, { firstName: "John", lastName: "Doe" }),
  ).rejects.toThrow(
    'Invalid argument `id` for `db.get`: expected to be an Id<"users">, got Id<"usersExplicitIncorrectTable"> instead.',
  );
});

test("create, update and delete", async () => {
  const t = make();
  const getUserCount = () => t.run(async (ctx) => ((await ctx.db.query("userCount").first()) as any)?.count ?? null);

  expect(await getUserCount()).toBeNull();
  const userId = await t.mutation(api.createUserExplicit, { firstName: "Jane", lastName: "Smith" });
  expect(await getUserCount()).toBe(1);
  const user2Id = await t.mutation(api.createUserExplicit, { firstName: "Alex", lastName: "Johnson" });
  expect(await getUserCount()).toBe(2);
  await t.mutation(api.updateUser, { id: userId, firstName: "Janet" });
  expect(await getUserCount()).toBe(2);
  await t.mutation(api.deleteUser, { id: userId });
  expect(await getUserCount()).toBe(1);
  await t.mutation(api.deleteUser, { id: user2Id });
  expect(await getUserCount()).toBe(0);
});

test("triggers.wrapDB preserves `this` binding for a wrapped db", async () => {
  const t = make();
  const result = await t.mutation(api.createUserAndReadBackWithGuardedDb, { firstName: "John", lastName: "Doe" });
  expect(result).toStrictEqual({ normalizedIsNonNull: true, readBackMatches: true });
});

test("writes to a table without triggers skip the trigger path", async () => {
  const t = make();
  await t.run(async (ctx) => {
    const reads: string[] = [];
    const innerDb = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === "get")
          return (table: any, id: any) => {
            reads.push(table);
            return target.get(table, id);
          };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const changes: string[] = [];
    const localTriggers = new Triggers<DataModel>();
    localTriggers.register("users", async (_ctx, change) => {
      changes.push(change.operation);
    });
    const db = writerWithTriggers(ctx, innerDb, localTriggers);

    const countId = await db.insert("userCount", { count: 0 });
    await db.patch("userCount", countId, { count: 1 });
    await db.replace("userCount", countId, { count: 2 });
    expect((await ctx.db.get("userCount", countId)).count).toBe(2);
    await db.delete("userCount", countId);
    expect(await ctx.db.get("userCount", countId)).toBeNull();
    // The id-only forms of an id of a table without triggers go straight through too.
    const countId2 = await db.insert("userCount", { count: 0 });
    await db.patch(countId2, { count: 1 });
    await db.replace(countId2, { count: 2 });
    await db.delete(countId2);
    expect(reads).toStrictEqual([]);
    expect(changes).toStrictEqual([]);

    // Writes to a table with triggers read the document around the write.
    const userId = await db.insert("users", { firstName: "John", lastName: "Doe", fullName: "John Doe" });
    await db.patch("users", userId, { firstName: "Jane" });
    await db.replace("users", userId, { firstName: "Jane", lastName: "Roe", fullName: "Jane Roe" });
    await db.delete("users", userId);
    expect(changes).toStrictEqual(["insert", "update", "update", "delete"]);
    // insert: after; patch and replace: before and after; delete: before.
    expect(reads).toStrictEqual(Array(6).fill("users"));
  });
});

test("a trigger gets the change, ctx with the wrapped db and innerDb, and the pass-throughs", async () => {
  const t = make();
  await t.run(async (ctx) => {
    const seen: { change: Change<DataModel, "users">; ctx: any }[] = [];
    const local = new Triggers<DataModel>();
    local.register("users", async (triggerCtx, change) => {
      seen.push({ change, ctx: triggerCtx });
    });
    const wrapped = local.wrapDB(ctx);
    // `ctx`'s getters (a mutation's lazy `rooms`, AD-42) stay getters in the wrapped ctx, as in custom functions.
    const getters = (o: object) =>
      Object.entries(Object.getOwnPropertyDescriptors(o))
        .filter(([, d]) => d.get)
        .map(([k]) => k);
    expect(getters(ctx)).toContain("rooms");
    expect(getters(wrapped)).toStrictEqual(getters(ctx));
    expect(wrapped.auth).toBe(ctx.auth);
    expect(wrapped.db).not.toBe(ctx.db);
    // bunvex's `db.system` and `db.vars` are new objects on each read: the wrapper holds the ones it read.
    expect(wrapped.db.system).toBeInstanceOf(ctx.db.system.constructor);
    expect(await wrapped.db.system.query("_scheduled_functions").collect()).toStrictEqual([]);
    expect(wrapped.db.vars.commitTs).toBe(ctx.db.vars.commitTs);

    // The id-only form finds the table by `normalizeId` over the tables with triggers.
    const id = await wrapped.db.insert("users", { firstName: "A", lastName: "B", fullName: "A B" });
    await wrapped.db.patch(id, { firstName: "C" });
    await wrapped.db.delete(id);
    expect(
      seen.map((s) => [s.change.operation, s.change.oldDoc?.firstName ?? null, s.change.newDoc?.firstName ?? null]),
    ).toStrictEqual([
      ["insert", null, "A"],
      ["update", "A", "C"],
      ["delete", "C", null],
    ]);
    for (const { change, ctx: triggerCtx } of seen) {
      expect(change.id).toBe(id);
      expect(triggerCtx.innerDb).toBe(ctx.db);
      expect(triggerCtx.auth).toBe(ctx.auth);
      expect(triggerCtx.db).not.toBe(ctx.db);
      expect(triggerCtx.db).not.toBe(wrapped.db);
    }

    // The deprecated class does the same.
    const kinds: string[] = [];
    const other = new Triggers<DataModel>();
    other.register("userCount", async (_ctx, change) => {
      kinds.push(change.operation);
    });
    const classDb = new DatabaseWriterWithTriggers(ctx, ctx.db, other);
    expect(classDb.system).toBeInstanceOf(ctx.db.system.constructor);
    expect(classDb.vars.commitTs).toBe(ctx.db.vars.commitTs);
    const countId = await classDb.insert("userCount", { count: 1 });
    await classDb.replace(countId, { count: 2 });
    expect((await classDb.get(countId))?.count).toBe(2);
    await classDb.delete("userCount", countId);
    expect(kinds).toStrictEqual(["insert", "update", "delete"]);
  });
});

test("recursive triggers run breadth-first, each change's triggers in registration order", async () => {
  const t = make();
  const log = await t.mutation(api.createNode, { name: "r" });
  expect(log).toStrictEqual([
    "first r",
    "second r",
    "first r0",
    "second r0",
    "first r1",
    "second r1",
    "first r00",
    "second r00",
    "first r01",
    "second r01",
    "first r10",
    "second r10",
    "first r11",
    "second r11",
  ]);
});

test("the first trigger error is thrown after the drain, the others logged", async () => {
  const t = make();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await t.run(async (ctx) => {
      const ran: string[] = [];
      const local = new Triggers<DataModel>();
      local.register("log", async () => {
        ran.push("a");
        throw new Error("first");
      });
      local.register("log", async () => {
        ran.push("b");
        throw new Error("second");
      });
      local.register("log", async (_ctx, change) => {
        ran.push(`c ${change.operation}`);
      });
      const db = writerWithTriggers(ctx, ctx.db, local);
      try {
        await db.insert("log", { entry: "x" });
        return { error: null, ran };
      } catch (error) {
        return { error: (error as Error).message, ran };
      }
    });
    expect(result).toStrictEqual({ error: "first", ran: ["a", "b", "c insert"] });
    expect(logged.mock.calls.map((call) => (call[0] as Error).message)).toStrictEqual(["second"]);
  } finally {
    logged.mockRestore();
  }
});

// DV-545: convex-helpers keeps its locks and queue in module variables, one request's on Convex. bunvex evaluates an
// app's modules once per code version, so module variables would be every mutation's: this test fails under them.
// Both mutations write to `events`, whose trigger waits until both mutations are in it (fixtures/triggers). With locks
// per transaction, each mutation's write and trigger run regardless of the other's, so they meet and both finish. With
// locks shared across requests, the second's write waits for the first's drain, which waits for the second: the test
// then opens the gate itself, after 2 s, and the rows show neither trigger saw the other.
test("two mutations writing to tables with triggers run independently", async () => {
  const t = make();
  await t.mutation(api.resetGate, {});
  const both = Promise.all([t.mutation(api.writeEvent, { name: "a" }), t.mutation(api.writeEvent, { name: "b" })]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    both.then(() => "both finished"),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("stuck"), 2000);
    }),
  ]);
  clearTimeout(timer);
  if (outcome === "stuck") await t.mutation(api.openGate, {});
  await both;
  const rows = await t.run(async (ctx) =>
    (await ctx.db.query("events").collect()).map((row: any) => [row.name, row.peerArrived]),
  );
  expect(outcome).toBe("both finished");
  expect(rows.sort()).toStrictEqual([
    ["a", true],
    ["b", true],
  ]);
});

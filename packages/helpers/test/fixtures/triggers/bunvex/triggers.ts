// The functions of convex-helpers' `triggers.test.ts` (e48f9df), defined with `@bunvex/helpers`' triggers and custom
// builders and pushed by `bunvexTest` (STUDY-181 PR 5), so the tests call them as an app does.
//
// Where it differs from upstream's:
// - `createUserAndReadBackWithGuardedDb` wraps the database in `GuardedWriter`, a class whose methods read their
//   `this`, where upstream uses `rowLevelSecurity`'s `wrapDatabaseWriter` (not ported yet): what it checks is the
//   same, that `wrapDB` keeps `get`, `query` and `normalizeId` bound to the database they come from.
// - Added: `nodes` (the order recursive triggers run in) and `events` (two mutations at once, DV-545).
// biome-ignore-all lint/suspicious/noExplicitAny: the guarded database forwards convex-helpers' untyped overloads
import { customCtx, customMutation } from "@bunvex/helpers/server/customFunctions";
import { Triggers } from "@bunvex/helpers/server/triggers";
import {
  type DataModelFromSchemaDefinition,
  type GenericDatabaseWriter,
  type MutationBuilder,
  mutationGeneric,
} from "@bunvex/server";
import { v } from "@bunvex/values";
import type schema from "./schema.ts";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type DatabaseWriter = GenericDatabaseWriter<DataModel>;
const rawMutation = mutationGeneric as MutationBuilder<DataModel, "public">;

const triggers = new Triggers<DataModel>();

triggers.register("users", async (ctx, change) => {
  if (change.newDoc) {
    const fullName = `${change.newDoc.firstName} ${change.newDoc.lastName}`;
    // The id-only form: the wrapped database finds the table by `normalizeId`.
    if (change.newDoc.fullName !== fullName) await ctx.db.patch(change.id, { fullName });
  }
});
triggers.register("usersExplicit", async (ctx, change) => {
  if (change.newDoc) {
    const fullName = `${change.newDoc.firstName} ${change.newDoc.lastName}`;
    if (change.newDoc.fullName !== fullName) await ctx.db.patch("usersExplicit", change.id, { fullName });
  }
});
triggers.register("usersExplicitIncorrectTable", async (ctx, change) => {
  if (change.newDoc) {
    const fullName = `${change.newDoc.firstName} ${change.newDoc.lastName}`;
    // The wrong table for this id, on purpose: the types refuse it (`GenericId<NonUnion<TableName>>`, as Convex's), so
    // it is cast, and at run time it fails as on Convex. Upstream marks it `@ts-expect-error`.
    if (change.newDoc.fullName !== fullName) await ctx.db.patch("users", change.id as never, { fullName });
  }
});

// A denormalized count of the users.
triggers.register("usersExplicit", async (ctx, change) => {
  const countDoc = await ctx.db.query("userCount").first();
  const currentCount = countDoc?.count ?? 0;
  const countId = countDoc?._id ?? (await ctx.db.insert("userCount", { count: 0 }));
  if (change.operation === "insert") await ctx.db.patch("userCount", countId, { count: currentCount + 1 });
  else if (change.operation === "delete") await ctx.db.patch("userCount", countId, { count: currentCount - 1 });
});

// Two triggers on `nodes`: the first logs the change and, above depth 2, inserts two children; the second only logs.
// The log shows the order they ran in.
triggers.register("nodes", async (ctx, change) => {
  if (!change.newDoc) return;
  await ctx.db.insert("log", { entry: `first ${change.newDoc.name}` });
  if (change.newDoc.depth < 2) {
    for (const child of ["0", "1"])
      await ctx.db.insert("nodes", { name: change.newDoc.name + child, depth: change.newDoc.depth + 1 });
  }
});
triggers.register("nodes", async (ctx, change) => {
  if (change.newDoc) await ctx.db.insert("log", { entry: `second ${change.newDoc.name}` });
});

// Two mutations at once (DV-545). Each one's trigger waits at `gate` until both have reached it, so they finish only
// if each runs its trigger while the other is in its own. Under locks shared by every mutation (convex-helpers' module
// variables, which bunvex evaluates once per code version), the second's write waits for the first's drain, the
// first's trigger for the second: the test then opens the gate itself (`openGate`), and each row records that its
// trigger never saw the other arrive.
let arrivals = 0;
let forced = false;
let openTheGate = () => {};
let gate = new Promise<void>((resolve) => {
  openTheGate = resolve;
});
triggers.register("events", async (ctx, change) => {
  arrivals += 1;
  if (arrivals === 2) openTheGate();
  await gate;
  await ctx.innerDb.patch("events", change.id, { peerArrived: !forced });
});

const mutation = customMutation(rawMutation, customCtx(triggers.wrapDB));

export const createUser = mutation({
  args: { firstName: v.string(), lastName: v.string() },
  handler: async (ctx, args) => ctx.db.insert("users", { ...args, fullName: "" }),
});

export const createUserExplicit = mutation({
  args: { firstName: v.string(), lastName: v.string() },
  handler: async (ctx, args) => ctx.db.insert("usersExplicit", { ...args, fullName: "" }),
});

export const createUserExplicitIncorrectTable = mutation({
  args: { firstName: v.string(), lastName: v.string() },
  handler: async (ctx, args) => ctx.db.insert("usersExplicitIncorrectTable", { ...args, fullName: "" }),
});

export const updateUser = mutation({
  args: { id: v.id("usersExplicit"), firstName: v.string() },
  handler: async (ctx, { id, firstName }) => ctx.db.patch("usersExplicit", id, { firstName }),
});

export const deleteUser = mutation({
  args: { id: v.id("usersExplicit") },
  handler: async (ctx, args) => ctx.db.delete("usersExplicit", args.id),
});

export const createNode = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    await ctx.db.insert("nodes", { name, depth: 0 });
    return (await ctx.db.query("log").collect()).map((row) => row.entry);
  },
});

export const writeEvent = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => ctx.db.insert("events", { name, peerArrived: false }),
});

/** Opens the gate of `events`' trigger for a mutation stuck at it, and resets it for the next test. */
export const openGate = rawMutation({
  args: {},
  handler: async () => {
    forced = true;
    openTheGate();
  },
});
export const resetGate = rawMutation({
  args: {},
  handler: async () => {
    arrivals = 0;
    forced = false;
    gate = new Promise<void>((resolve) => {
      openTheGate = resolve;
    });
  },
});

/**
 * A database wrapper whose methods read `this` (a private field), as `rowLevelSecurity`'s `wrapDatabaseWriter` does:
 * called unbound, they throw.
 */
class GuardedWriter {
  readonly #db: DatabaseWriter;
  constructor(db: DatabaseWriter) {
    this.#db = db;
  }
  get system() {
    return this.#db.system;
  }
  get vars() {
    return this.#db.vars;
  }
  get(...args: [any, any?]) {
    return (this.#db.get as any)(...args);
  }
  query(table: any) {
    return this.#db.query(table);
  }
  normalizeId(table: any, id: string) {
    return this.#db.normalizeId(table, id);
  }
  insert(table: any, value: any) {
    return this.#db.insert(table, value);
  }
  patch(...args: [any, any, any?]) {
    return (this.#db.patch as any)(...args);
  }
  replace(...args: [any, any, any?]) {
    return (this.#db.replace as any)(...args);
  }
  delete(...args: [any, any?]) {
    return (this.#db.delete as any)(...args);
  }
}

const triggersForGuardedDb = new Triggers<DataModel>();
const mutationGuardedThenTriggers = customMutation(
  rawMutation,
  customCtx((ctx) => {
    const db = new GuardedWriter(ctx.db) as unknown as DatabaseWriter;
    // The guarded database and the triggers in one customization.
    return triggersForGuardedDb.wrapDB({ ...ctx, db });
  }),
);

export const createUserAndReadBackWithGuardedDb = mutationGuardedThenTriggers({
  args: { firstName: v.string(), lastName: v.string() },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("users", { ...args, fullName: "" });
    // `wrapDB` must keep `get`, `query` and `normalizeId` bound to the guarded database.
    const normalized = ctx.db.normalizeId("users", id);
    const doc = await ctx.db.get("users", id);
    const first = await ctx.db.query("users").first();
    return { normalizedIsNonNull: normalized !== null, readBackMatches: doc?._id === id && first?._id === id };
  },
});

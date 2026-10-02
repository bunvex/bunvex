// Deployment environment variables (STUDY-37): Convex's validation, limits and messages; a batch is one
// transaction, removals first; and a function's read of one name is in its read set, so the query cache
// serves a result until that name (set or not) changes, and only then.
import { expect, test } from "bun:test";
import { Engine } from "../src/engine.ts";
import { EnvironmentVariableError } from "../src/environment-variables.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema } from "../src/schema.ts";

const engine = async () => new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
const update = (e: Engine, changes: { name: string; value: string | null }[], forbidden: string[] = []) =>
  e.mutation((db) => e.environment.update(db, changes, forbidden));
const list = (e: Engine) => e.query((db) => e.environment.list(db));
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(EnvironmentVariableError);
    return { code: (err as EnvironmentVariableError).code, message: (err as Error).message };
  }
  throw new Error("expected a failure");
};

test("names, values and limits, with Convex's codes and messages", async () => {
  const e = await engine();
  expect(await fail(update(e, [{ name: "1X", value: "v" }]))).toEqual({
    code: "EnvironmentVariableNameInvalid",
    message:
      "The environment variable name 1X is invalid. Environment variable names must begin with a letter and may only include characters a-z, A-Z, 0-9, and underscores.",
  });
  await update(e, [{ name: "_LEADING_UNDERSCORE", value: "ok" }]); // Convex's regex accepts it
  expect((await fail(update(e, [{ name: "A".repeat(257), value: "v" }]))).code).toBe("EnvironmentVariableNameTooLong");
  await update(e, [{ name: "A".repeat(256), value: "v" }]);
  expect(await fail(update(e, [{ name: "BIG", value: "x".repeat(8193) }]))).toEqual({
    code: "EnvironmentVariableValueTooLarge",
    message: "The environment variable value is 8193 bytes, which is too large. (max size: 8192",
  });
  expect(await fail(update(e, [{ name: "BUNVEX_SITE_URL", value: "x" }], ["BUNVEX_SITE_URL"]))).toEqual({
    code: "EnvVarNameForbidden",
    message: 'Environment variable with name "BUNVEX_SITE_URL" is built-in and cannot be overridden',
  });
  expect(
    (
      await fail(
        update(e, [
          { name: "D", value: "1" },
          { name: "D", value: "2" },
        ]),
      )
    ).code,
  ).toBe("EnvVarNameNotUnique");
  // 64 values of 8 KiB, plus their names: over 512 KiB.
  const big = Array.from({ length: 64 }, (_, i) => ({ name: `V${i}`, value: "x".repeat(8192) }));
  expect(await fail(update(e, big))).toMatchObject({ code: "EnvVarTotalSizeLimitMet" });
  const many = Array.from({ length: 511 }, (_, i) => ({ name: `N${i}`, value: "1" }));
  expect(await fail(update(e, many))).toEqual({
    code: "EnvVarLimitMet",
    message: "The environment variable limit (512) has been met.",
  });
  // A refused batch changed nothing.
  expect((await list(e)).map((v) => v.name)).toEqual(["A".repeat(256), "_LEADING_UNDERSCORE"]);
  await e.close();
});

test("a batch: removals before sets, a set replaces, by_name order", async () => {
  const e = await engine();
  await update(e, [
    { name: "B", value: "1" },
    { name: "A", value: "1" },
  ]);
  await update(e, [
    { name: "A", value: "2" },
    { name: "B", value: null },
    { name: "C", value: "3" },
    { name: "MISSING", value: null },
  ]);
  expect(await list(e)).toEqual([
    { name: "A", value: "2" },
    { name: "C", value: "3" },
  ]);
  await e.close();
});

test("a read is in the read set: the cache serves it until that name changes", async () => {
  const e = await engine();
  let runs = 0;
  const read = (name: string) =>
    e.query(async (db) => {
      runs++;
      return (await e.environment.reader(db))(name) ?? null;
    }, `read:${name}`);
  expect(await read("X")).toBe(null);
  expect(await read("X")).toBe(null);
  expect(runs).toBe(1);
  await update(e, [{ name: "OTHER", value: "1" }]); // another name: still cached
  expect(await read("X")).toBe(null);
  expect(runs).toBe(1);
  await update(e, [{ name: "X", value: "1" }]); // a missing name, set: re-runs
  expect(await read("X")).toBe("1");
  expect(runs).toBe(2);
  await update(e, [{ name: "X", value: "2" }]);
  expect(await read("X")).toBe("2");
  await update(e, [{ name: "X", value: null }]);
  expect(await read("X")).toBe(null);
  expect(runs).toBe(4);
  // A name that does not parse throws, as Convex's op.
  await expect(e.query(async (db) => (await e.environment.reader(db))("a-b"))).rejects.toThrow(/is invalid/);
  await e.close();
});

test("the snapshot cache follows commits, and an older snapshot reads its own values", async () => {
  const e = await engine();
  await update(e, [{ name: "X", value: "old" }]);
  const before = e.committer.visibleTs;
  const at = (ts?: number) =>
    e.query(async (db) => (await e.environment.snapshot(db)).get("X") ?? null, undefined, undefined, undefined, ts);
  expect(await at()).toBe("old");
  await update(e, [{ name: "X", value: "new" }]);
  expect(await at()).toBe("new");
  expect(await at(before)).toBe("old");
  expect(await at()).toBe("new");
  await e.close();
});

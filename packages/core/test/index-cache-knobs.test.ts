// STUDY-136: which engines get an index cache, from their option and Convex's knobs INDEX_CACHE_SIZE
// (512 MiB; 0 turns it off) and INDEX_CACHE_VERIFY_PERCENT (0 here, DV-433); the memory driver has none
// unless asked (DV-434).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine, INDEX_CACHE_MAX_BYTES } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";

const saved = { size: process.env.INDEX_CACHE_SIZE, verify: process.env.INDEX_CACHE_VERIFY_PERCENT };
afterEach(() => {
  for (const [k, v] of [
    ["INDEX_CACHE_SIZE", saved.size],
    ["INDEX_CACHE_VERIFY_PERCENT", saved.verify],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});
const env = (size?: string, verify?: string) => {
  if (size === undefined) delete process.env.INDEX_CACHE_SIZE;
  else process.env.INDEX_CACHE_SIZE = size;
  if (verify === undefined) delete process.env.INDEX_CACHE_VERIFY_PERCENT;
  else process.env.INDEX_CACHE_VERIFY_PERCENT = verify;
};
const schema = defineSchema({});
const memory = async (opts = {}) => new Engine(schema, await MemoryPersistence.open(null, { durable: false }), opts);
const sqlite = (opts = {}) => new Engine(schema, new SqlitePersistence(":memory:", { durable: true }), opts);

test("on by default, at Convex's size, verifying nothing", () => {
  env();
  const c = sqlite().indexCache!;
  expect(c.maxBytes).toBe(INDEX_CACHE_MAX_BYTES);
  expect(INDEX_CACHE_MAX_BYTES).toBe(512 * 1024 * 1024);
  expect(c.verifyPercent).toBe(0);
});

test("the knobs: size, verification, 0 turns it off", () => {
  env("1048576", "25");
  expect(sqlite().indexCache).toMatchObject({ maxBytes: 1048576, verifyPercent: 25 });
  env("0");
  expect(sqlite().indexCache).toBeNull();
  env("lots");
  expect(() => sqlite()).toThrow("INDEX_CACHE_SIZE must be a number of bytes");
  env(undefined, "101");
  expect(() => sqlite()).toThrow("INDEX_CACHE_VERIFY_PERCENT must be from 0 to 100");
});

test("the option wins over the knobs; false turns it off", () => {
  env("0", "0");
  expect(sqlite({ indexCache: { maxBytes: 4096, verifyPercent: 100 } }).indexCache).toMatchObject({
    maxBytes: 4096,
    verifyPercent: 100,
  });
  env();
  expect(sqlite({ indexCache: false }).indexCache).toBeNull();
});

test("the memory driver has none unless INDEX_CACHE_SIZE or the option asks", async () => {
  env();
  expect((await memory()).indexCache).toBeNull();
  expect((await memory({ indexCache: {} })).indexCache).not.toBeNull();
  env(String(INDEX_CACHE_MAX_BYTES));
  expect((await memory()).indexCache).not.toBeNull();
});

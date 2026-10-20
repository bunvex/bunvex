import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { canonicalInstanceSecret, instanceSecretBytes } from "../src/kbkdf.ts";
import type { Persistence } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ items: defineTable(v.any()) });
const dirs: string[] = [];
const open: Persistence[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function logPath() {
  const d = mkdtempSync(join(tmpdir(), "bunvex-secret-"));
  dirs.push(d);
  return join(d, "log");
}
async function engine(path: string, instanceSecret?: string) {
  const p = await MemoryPersistence.open(path, { durable: false });
  open.push(p);
  return new Engine(schema, p, { instanceSecret }).init();
}
const firstPage = (e: Engine) => e.query((db) => db.query("items").paginate({ numItems: 2, cursor: null }));
const next = (e: Engine, cursor: string) => e.query((db) => db.query("items").paginate({ numItems: 2, cursor }));

describe("the instance secret, as Convex's self-hosted image (STUDY-17 D2 → option D)", () => {
  test("without INSTANCE_SECRET a random secret is generated once and kept with the data", async () => {
    const path = logPath();
    const a = await engine(path);
    for (let i = 0; i < 5; i++) await a.mutation((db) => db.insert("items", { i }));
    const cursor = (await firstPage(a)).continueCursor;
    await open.pop()!.close();
    const b = await engine(path); // a restart: the stored secret is read back
    expect((await next(b, cursor)).page.map((d) => d.i)).toEqual([2, 3]);
  });

  test("each deployment has its own secret: another store refuses the cursor", async () => {
    const a = await engine(logPath());
    const b = await engine(logPath());
    await a.mutation((db) => db.insert("items", {}));
    const cursor = (await firstPage(a)).continueCursor;
    await expect(next(b, cursor)).rejects.toThrow(/^Failed to parse cursor$/);
  });

  test("a configured INSTANCE_SECRET wins over the stored one", async () => {
    const path = logPath();
    const stored = await engine(path);
    const storedCursor = (await firstPage(stored)).continueCursor;
    await open.pop()!.close();
    const configured = await engine(path, "configured-secret");
    await expect(next(configured, storedCursor)).rejects.toThrow(/^Failed to parse cursor$/);
    const own = (await firstPage(configured)).continueCursor;
    expect((await next(configured, own)).isDone).toBe(true);
  });

  // Convex reads the secret with `const_hex::decode`, which drops one `0x` / `0X` (STUDY-172 §7).
  test("a secret's spellings (0x, 0X, case) are its 32 bytes: the same bytes, the same keys", async () => {
    const hex = "0123456789abcdef".repeat(4);
    const spellings = [hex, `0x${hex}`, `0X${hex}`, hex.toUpperCase(), `0x${hex.toUpperCase()}`];
    for (const s of spellings) {
      expect(instanceSecretBytes(s)).toEqual(new Uint8Array(Buffer.from(hex, "hex")));
      expect(canonicalInstanceSecret(s)).toBe(hex);
    }
    // Not 32 bytes after one prefix: not hex, the string's own bytes (and its own spelling).
    for (const s of [`0x0x${hex}`, `0x${hex}ab`, "0x", "s1"]) {
      expect(instanceSecretBytes(s)).toEqual(new TextEncoder().encode(s));
      expect(canonicalInstanceSecret(s)).toBe(s);
    }
    // Every key the engine derives, and a cursor, read the same under each spelling.
    const path = logPath();
    const a = await engine(path, hex);
    for (let i = 0; i < 5; i++) await a.mutation((db) => db.insert("items", { i }));
    const cursor = (await firstPage(a)).continueCursor;
    const keys = (e: Engine) => [e.secretKey("store file authorization"), e.derivedKey("admin key")];
    const expected = keys(a);
    await open.pop()!.close();
    for (const s of spellings.slice(1)) {
      const b = await engine(path, s);
      expect(keys(b)).toEqual(expected);
      expect((await next(b, cursor)).page.map((d) => d.i)).toEqual([2, 3]);
      await open.pop()!.close();
    }
    const other = await engine(path, `0x0x${hex}`);
    expect(keys(other)[0]).not.toEqual(expected[0]);
    await expect(next(other, cursor)).rejects.toThrow(/^Failed to parse cursor$/);
  });

  test("app code cannot read _instance", async () => {
    const e = await engine(logPath());
    await expect(e.query((db) => db.query("_instance").collect())).rejects.toThrow(
      "System tables can only be accessed from db.system.query().",
    );
  });
});

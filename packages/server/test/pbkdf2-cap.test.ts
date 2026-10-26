// PBKDF2's bound in functions, as Convex's runtime has it since 8856603 (crates/webcrypto/src/pbkdf2.rs): a
// `deriveBits` or `deriveKey` whose iterations times its output's bytes (64 at least) pass 150 000 000 rejects with
// an `OperationError` "too many iterations", after the key's algorithm and usage are checked; a "use node" action has
// no bound, as Node's (STUDY-186 A4). The oracle case: packages/differential `pbkdf2-cap.test.ts`.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { CodeVersion, type ModuleSource } from "../src/code-version.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { PBKDF2_MAX_WORK, pbkdf2Refusal } from "../src/web-crypto.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const DERIVE = `
  async function derive(a) {
    const usages = a.usage ? [a.usage] : ["deriveBits", "deriveKey"];
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("pw"), "PBKDF2", false, usages);
    const params = { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(16), iterations: a.iterations };
    try {
      if (a.type) {
        const k = await crypto.subtle.deriveKey(params, key, a.type, true, a.type.name === "HMAC" ? ["sign"] : ["encrypt"]);
        return { ok: k.algorithm.name };
      }
      return { ok: (await crypto.subtle.deriveBits(params, key, a.bits)).byteLength };
    } catch (e) {
      return { error: [e.constructor.name, e.name, e.message] };
    }
  }`;

async function deployment() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine);
  const mods: ModuleSource[] = [
    {
      path: "c.js",
      environment: "isolate",
      source: `import { query, mutation, action } from "@bunvex/server";${DERIVE}
        export const q = query(async (_, a) => derive(a));
        export const m = mutation(async (_, a) => derive(a));
        export const a = action(async (_, a) => derive(a));`,
    },
    {
      path: "n.js",
      environment: "node",
      source: `"use node"; import { action } from "@bunvex/server";${DERIVE}
        export const a = action(async (_, a) => derive(a));`,
    },
  ];
  const version = await CodeVersion.load(mods, { seed: Uint32Array.of(1, 2, 3, 4), timestamp: 1_700_000_000_000 });
  functions.install(version.functions, version.moduleHashes);
  const s = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(s.stop);
  return async (kind: string, path: string, args: object) => {
    const r = (await (
      await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args, format: "json" }),
      })
    ).json()) as { status: string; value: unknown; errorMessage?: string };
    expect(r.errorMessage).toBeUndefined();
    return r.value;
  };
}

const TOO_MANY = { error: ["DOMException", "OperationError", "too many iterations"] };

describe("PBKDF2's bound in functions", () => {
  test("past the bound, deriveBits and deriveKey reject in queries, mutations and V8 actions", async () => {
    const call = await deployment();
    for (const [kind, path] of [
      ["query", "c:q"],
      ["mutation", "c:m"],
      ["action", "c:a"],
    ]) {
      // 32 bytes count as 64: 2 343 751 × 64 is one past the bound.
      expect(await call(kind!, path!, { iterations: 2_343_751, bits: 256 })).toEqual(TOO_MANY);
      expect(await call(kind!, path!, { iterations: 10_000_000, bits: 512 })).toEqual(TOO_MANY);
      expect(await call(kind!, path!, { iterations: 10_000_000, type: { name: "AES-GCM", length: 256 } })).toEqual(
        TOO_MANY,
      );
      // HMAC's length defaults to its hash's block: 1024 bits for SHA-512.
      expect(await call(kind!, path!, { iterations: 1_171_876, type: { name: "HMAC", hash: "SHA-512" } })).toEqual(
        TOO_MANY,
      );
      // Under it, the derivation runs.
      expect(await call(kind!, path!, { iterations: 1000, bits: 256 })).toEqual({ ok: 32 });
      expect(await call(kind!, path!, { iterations: 1000, type: { name: "AES-GCM", length: 256 } })).toEqual({
        ok: "AES-GCM",
      });
    }
  });

  test("Convex's earlier checks come first: a key without the usage, zero iterations, a bad length", async () => {
    const call = await deployment();
    expect(await call("query", "c:q", { iterations: 10_000_000, bits: 256, usage: "deriveKey" })).toEqual({
      error: ["DOMException", "InvalidAccessError", "baseKey does not have deriveBits usage"],
    });
    expect(await call("query", "c:q", { iterations: 10_000_000, bits: 7 })).toEqual({
      error: ["DOMException", "OperationError", "length must be a multiple of 8"],
    });
    expect(((await call("query", "c:q", { iterations: 0, bits: 256 })) as { error: string[] }).error[1]).toBe(
      "OperationError",
    );
  });

  test('a "use node" action has no bound, as Node\'s', async () => {
    const call = await deployment();
    expect(await call("action", "n:a", { iterations: 2_343_751, bits: 256 })).toEqual({ ok: 32 });
  });

  test("the bound: iterations × max(bytes, 64) at most 150 000 000", async () => {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(2), "PBKDF2", false, ["deriveBits"]);
    const at = (iterations: number, bits: number) =>
      pbkdf2Refusal({ name: "pbkdf2", hash: "SHA-1", salt: new Uint8Array(), iterations }, key, bits, "deriveBits")
        ?.message ?? "derives";
    expect(PBKDF2_MAX_WORK).toBe(150_000_000);
    expect([at(2_343_750, 8), at(2_343_750, 512), at(2_343_751, 8)]).toEqual([
      "derives",
      "derives",
      "too many iterations",
    ]);
    // 64 KiB, the most Convex derives: 2288 iterations fit, 2289 do not.
    expect([at(2288, 8 * 65536), at(2289, 8 * 65536)]).toEqual(["derives", "too many iterations"]);
    // Past 64 KiB, Convex's length check fires first.
    expect([at(1, 8 * 65537), at(10_000_000, 8 * 65537)]).toEqual([
      "cannot generate more than 524288 bits",
      "cannot generate more than 524288 bits",
    ]);
  });
});

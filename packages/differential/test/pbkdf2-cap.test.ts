// PBKDF2's bound (Convex's 8856603, crates/webcrypto/src/pbkdf2.rs; STUDY-186 A4), on Convex's backend (the oracle)
// and on bunvex's: `deriveBits` and `deriveKey` in a query, a mutation and a V8 action, under and past
// `iterations × max(bytes, 64) ≤ 150 000 000`, past 64 KiB, and after the checks that come before it; a "use node"
// action, which has no bound. The error's name and message are compared (its class is each runtime's own
// DOMException). Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`pbkdf2-cap: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../pbkdf2-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

async function value(b: Backend, kind: "query" | "mutation" | "action", path: string, args: object) {
  const { body } = await b.call(kind, path, args);
  const a = body as { status: string; value?: unknown; errorMessage?: string };
  expect({ path, args, status: a.status, error: a.errorMessage }).toEqual({
    path,
    args,
    status: "success",
    error: undefined,
  });
  return a.value;
}

const CASES: object[] = [
  // Under the bound, and one past it (32 bytes count as 64).
  { iterations: 1000, bits: 256 },
  { iterations: 2_343_751, bits: 256 },
  { iterations: 10_000_000, bits: 512 },
  // 64 KiB: 2289 iterations are one past; past 64 KiB, the length's own bound.
  { iterations: 2289, bits: 8 * 65536 },
  { iterations: 1, bits: 8 * 65537 },
  { iterations: 10_000_000, bits: 8 * 65537 },
  // deriveKey: AES's length, HMAC's hash block (1024 bits for SHA-512).
  { iterations: 1000, type: { name: "AES-GCM", length: 256 } },
  { iterations: 10_000_000, type: { name: "AES-GCM", length: 256 } },
  { iterations: 1_171_876, type: { name: "HMAC", hash: "SHA-512" } },
  // What comes before it: the key's usage, the length's multiple of 8.
  { iterations: 10_000_000, bits: 256, usage: "deriveKey" },
  { iterations: 10_000_000, bits: 7 },
];

describe.skipIf(!ready)("PBKDF2's bound, against Convex's backend", () => {
  test("in a query, a mutation and a V8 action: the same results and errors", async () => {
    const seen: unknown[] = [];
    for (const [kind, path] of [
      ["query", "derive:q"],
      ["mutation", "derive:m"],
      ["action", "derive:a"],
    ] as const)
      for (const args of CASES) {
        const c = await value(convex, kind, path, args);
        const b = await value(bunvex, kind, path, args);
        // Bun's own wording for a key without the usage (InvalidAccessError on both).
        const own = (x: unknown) =>
          (x as { error?: string[] }).error?.[0] === "InvalidAccessError" ? { error: ["InvalidAccessError"] } : x;
        expect({ path, args, b: own(b) }).toEqual({ path, args, b: own(c) });
        if (kind === "query") seen.push(c);
      }
    const TOO_MANY = { error: ["OperationError", "too many iterations"] };
    const TOO_LONG = { error: ["OperationError", "cannot generate more than 524288 bits"] };
    expect(seen).toEqual([
      { ok: 32 },
      TOO_MANY,
      TOO_MANY,
      TOO_MANY,
      TOO_LONG,
      TOO_LONG,
      { ok: "AES-GCM" },
      TOO_MANY,
      TOO_MANY,
      { error: ["InvalidAccessError", expect.any(String)] },
      { error: ["OperationError", "length must be a multiple of 8"] },
    ]);
  });

  test('a "use node" action derives past the bound', async () => {
    const args = { iterations: 2_343_751, bits: 256 };
    expect(await value(convex, "action", "node:a", args)).toEqual({ ok: 32 });
    expect(await value(bunvex, "action", "node:a", args)).toEqual({ ok: 32 });
  });
});

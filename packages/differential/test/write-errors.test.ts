// `db.insert`'s, `db.patch`'s, `db.replace`'s and `db.count`'s argument errors (STUDY-161 §1, §2), on Convex's
// backend (the oracle) and on bunvex's, for the app of `write-errors-app/`: a table name that is not an identifier
// (every rule, Rust's display of the character), a value that is not an object, nested past the limit, or left
// out. The messages are compared after the request id and the frames (STUDY-150, DV-345). A function value is left
// out (Convex's serializer fails on it with a `TypeError` of its own, value-errors.test.ts). Local only: skipped,
// with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`write-errors: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../write-errors-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** A call's error text on a backend (it must fail). */
async function error(b: Backend, kind: "query" | "mutation", path: string, args: unknown) {
  const { body } = await b.call(kind, path, args);
  const a = body as { status: string; errorMessage?: string };
  expect({ path, args, status: a.status }).toEqual({ path, args, status: "error" });
  return errorText(a.errorMessage!);
}

/** The same calls on both backends: the same messages. */
async function same(kind: "query" | "mutation", path: string, cases: unknown[]) {
  for (const args of cases) {
    const c = await error(convex, kind, path, args);
    expect({ args, text: await error(bunvex, kind, path, args) }).toEqual({ args, text: c });
  }
}

const NAMES = [
  "9lives",
  "",
  "a".repeat(65),
  "a-b",
  "__",
  "_x",
  "a b",
  "a\nb",
  "a\tb",
  "a'b",
  'a"b',
  "a\\b",
  "a\u0001b",
  "a\u007fb",
  "a b",
  "a­b",
  "a​b",
  "a b",
  "áb",
  "héllo",
  "a😀b",
];

describe.skipIf(!ready)("write argument errors, against Convex's backend", () => {
  test("db.insert's table: the identifier's message under the argument's prefix", async () => {
    await same(
      "mutation",
      "writes:insert",
      NAMES.map((table) => ({ table, value: {} })),
    );
    await same(
      "mutation",
      "writes:insertScoped",
      NAMES.slice(0, 4).map((table) => ({ table })),
    );
  });

  test("db.count's table: the same check under its own prefix", async () => {
    await same(
      "query",
      "writes:count",
      NAMES.slice(0, 4).map((table) => ({ table })),
    );
  });

  test("db.insert's value: not an object, nested past the limit, left out; checked before the table", async () => {
    await same("mutation", "writes:insert", [
      ...[1, "s", [1], null, true].map((value) => ({ table: "free", value })),
      { table: "9x", value: 1 },
      { table: "free", depth: 65 },
      { table: "9x", depth: 65 },
      { table: "free", omit: true },
    ]);
  });

  test("db.patch's and db.replace's value: not an object, left out", async () => {
    for (const method of ["patch", "replace"])
      await same("mutation", "writes:write", [
        ...[1, "s", [1], null, true].map((value) => ({ method, value })),
        { method, value: {}, omit: true },
      ]);
  });
});

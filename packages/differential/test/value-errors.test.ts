// A value that is not a supported value (the app of `value-errors-app/`), on Convex's backend (the oracle) and on
// bunvex's: returned by a query, a mutation, a V8 or a "use node" action, written by `db.insert`, or passed to
// `ctx.runQuery`. The app's frames match (where its code made the call; none for a returned value), and bunvex's
// error has no other frame. Convex's other frames are its `convex` library's, bundled with the app (its
// `values/value.ts`, `database_impl.ts`, `actions_impl.ts`): bunvex's runtime is the server's, not the app's, and
// shows none. The message's wording is decided (DV-316, rule 5); a function value is left out (Convex's
// serializer fails on it with a `TypeError` of its own). A `Set` or `Map`'s message is Convex's (STUDY-18 §9), its
// entries included, wherever the value goes. Local only: skipped, with a note, when Convex's backend
// is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`value-errors: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../value-errors-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** The error's frames: the app's (decided rewrites: its directory, DV-03; positions, DV-346), and the others. */
async function frames(b: Backend, kind: "query" | "mutation" | "action", path: string, k: string) {
  const { body } = await b.call(kind, path, { kind: k });
  const a = body as { status: string; errorMessage?: string };
  expect({ path, k, status: a.status }).toEqual({ path, k, status: "error" });
  const all = a.errorMessage!.split("\n").filter((l) => /^\s+at /.test(l));
  const app = (l: string) => /\(\.\.\/(convex|bunvex)\//.test(l);
  return {
    app: all.filter(app).map((l) => l.replace("../convex/", "../bunvex/").replace(/:\d+:\d+\)$/, ":N:N)")),
    other: all.filter((l) => !app(l)).length,
  };
}

const CASES = [
  ["query", "values:q"],
  ["mutation", "values:m"],
  ["action", "values:a"],
  ["action", "node:a"],
  ["mutation", "values:insert"],
  ["action", "values:runQueryWith"],
  ["action", "node:runQueryWith"],
] as const;

describe.skipIf(!ready)("a value that is not supported, against Convex's backend", () => {
  test("the app's frames as Convex's; no other frame on bunvex", async () => {
    for (const [kind, path] of CASES)
      for (const k of ["set", "map", "instance", "nested"]) {
        const c = await frames(convex, kind, path, k);
        const b = await frames(bunvex, kind, path, k);
        expect({ path, k, app: b.app }).toEqual({ path, k, app: c.app });
        expect({ path, k, other: b.other }).toEqual({ path, k, other: 0 });
      }
  });

  test("an action that catches a nested call's argument error: a plain Error, with frames", async () => {
    for (const b of [convex, bunvex]) {
      const { body } = await b.call("action", "values:runQueryCaught", { kind: "set" });
      expect((body as { value: unknown }).value).toEqual({ name: "Error", frames: true });
    }
  });
});

// Where a Set or Map can go, and the sizes and places it can have (STUDY-18 §9).
const SET_MAP_CASES = [
  ...CASES,
  ["query", "values:validated"],
  ["mutation", "values:patch"],
  ["mutation", "values:replace"],
  ["mutation", "values:schedule"],
  ["action", "values:scheduleFromAction"],
  ["action", "values:runMutationWith"],
  ["mutation", "values:runQueryFromMutation"],
  ["mutation", "values:runValidatedFromMutation"],
  ["action", "values:runValidatedFromAction"],
  ["mutation", "values:nestedValidated"],
] as const;
const SET_MAP_KINDS = [
  ...["set", "map", "nested", "setEmpty", "setOne", "setMany", "mapEmpty", "mapOne", "mapMany"],
  ...["inObject", "inArray", "setOfSets"],
];
/** The message, in bunvex's words (DV-04); a Set or Map that is not the one refused prints as `{}` (DV-316). */
async function message(b: Backend, kind: string, path: string, args: object) {
  const { body } = await b.call(kind as "query", path, args);
  const a = body as { status: string; errorMessage?: string };
  expect({ path, args, status: a.status }).toEqual({ path, args, status: "error" });
  const text = errorText(a.errorMessage!).replace(/^Server Error\n/, "");
  return b === bunvex ? text.replace(/\b(Set|Map) \{…\}/g, "{}") : text;
}

describe.skipIf(!ready)("a Set or Map that is not a value, against Convex's backend", () => {
  test("Convex's message, its entries printed, wherever it goes", async () => {
    for (const [kind, path] of SET_MAP_CASES)
      for (const k of SET_MAP_KINDS) {
        const c = await message(convex, kind, path, { kind: k });
        expect({ path, k, c }).toEqual({ path, k, c: expect.stringMatching(/^Uncaught Error: (Set|Map)\[/) });
        expect({ path, k, m: await message(bunvex, kind, path, { kind: k }) }).toEqual({ path, k, m: c });
      }
  });

  test("too large or too deep: the conversion fails first", async () => {
    for (const path of ["values:tooLarge", "values:tooDeep"])
      expect(await message(bunvex, "query", path, {})).toBe(await message(convex, "query", path, {}));
  });

  test("a nested call's arguments that are not an object: parseArgs' message, first", async () => {
    for (const [kind, path] of [
      ["mutation", "values:argsNotObjectFromMutation"],
      ["action", "values:argsNotObjectFromAction"],
    ])
      expect(await message(bunvex, kind, path, {})).toBe(await message(convex, kind, path, {}));
  });

  test("runAt takes the function's own Date", async () => {
    for (const b of [convex, bunvex])
      expect((await b.call("mutation", "values:scheduleAt", {})).body).toMatchObject({
        status: "success",
        value: true,
      });
  });
});

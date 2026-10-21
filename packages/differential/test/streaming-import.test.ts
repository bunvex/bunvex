// Streaming import (STUDY-141 PR 1): `/api/streaming_import/clear_tables`, `get_schema` and `replace_tables`
// on Convex's backend (the oracle) and on bunvex's, the same requests, compared answer by answer: statuses,
// codes and messages, the body limit, what a clear leaves (empty tables, kept indexes and table numbers,
// missing tables created) and the names Convex's `ValidIdentifier` makes, transliteration included (DV-450).
// The auth scheme is each backend's own (`Convex <key>` / `Bunvex <key>`, DV-448). Convex's local backend does
// not list its audit log (`AuditLogsDisabled`), so the `clear_tables` event is checked in the server's tests.
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`streaming-import: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

let convex: Backend;
let bunvex: Backend;

type Opts = { body?: string; auth?: "admin" | null | string; contentType?: string | null };

/**
 * A raw request to the admin API: auth `"admin"` (the backend's own scheme), none, or a header as given. Its
 * status, `allow` header and body, with the wording differences decided elsewhere rewritten to bunvex's:
 * - "npx convex import" is "bunvex import" (rule 5);
 * - `BadDeployKey` names no deployment. Convex's binary says "this deployment" where bunvex names it, on
 *   every admin route: a difference older than these routes, reported separately (STUDY-141 §8).
 */
async function raw(b: Backend, method: string, path: string, opts: Opts = {}) {
  const headers: Record<string, string> = {};
  const auth = opts.auth === undefined ? "admin" : opts.auth;
  if (auth === "admin") headers.authorization = `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;
  else if (auth !== null) headers.authorization = auth;
  const ct = opts.contentType === undefined ? "application/json" : opts.contentType;
  if (ct !== null) headers["content-type"] = ct;
  const r = await fetch(`${b.url}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: opts.body }),
  });
  const text = (await r.text())
    .replace("npx convex import", "bunvex import")
    .replace(/invalid for deployment '[^']*'/, "invalid for this deployment");
  let body: unknown = text;
  try {
    body = text === "" ? "" : JSON.parse(text);
  } catch {}
  return { status: r.status, allow: r.headers.get("allow"), body };
}

const both = async <T>(f: (b: Backend) => Promise<T>) => ({ convex: await f(convex), bunvex: await f(bunvex) });

async function value(b: Backend, kind: "query" | "mutation", path: string, args: unknown = {}) {
  const r = await b.call(kind, path, args);
  if (!r.ok) throw new Error(`${b.name} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { value: unknown }).value;
}

const insert = (b: Backend, table: string, doc: Record<string, unknown>) =>
  value(b, "mutation", "ops:apply", { ops: [{ kind: "insert", table, doc }] }).then((o) => (o as string[])[0]!);

/** The user tables a backend has (its `/api/shapes2` keys), sorted. */
async function tables(b: Backend) {
  const r = await raw(b, "GET", "/api/shapes2", { contentType: null });
  return Object.keys(r.body as object)
    .filter((t) => !t.startsWith("_"))
    .sort();
}

const clear = (tableNames: unknown) => (b: Backend) =>
  raw(b, "PUT", "/api/streaming_import/clear_tables", { body: JSON.stringify({ tableNames }) });

describe.skipIf(!ready)("streaming import on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await startAll([startConvex(), startBunvex()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("argument, method, auth and route errors", async () => {
    const cases: [string, string, Opts][] = [
      ["PUT", "/api/streaming_import/clear_tables", { body: '{"tableNames":[]}', auth: null }],
      ["PUT", "/api/streaming_import/clear_tables", { body: '{"tableNames":[]}', auth: "Foo bar" }],
      ["PUT", "/api/streaming_import/clear_tables", { body: '{"tableNames":[]}', contentType: null }],
      ["PUT", "/api/streaming_import/clear_tables", { body: '{"tableNames":[]}', contentType: "text/plain" }],
      ["PUT", "/api/streaming_import/clear_tables", { body: "{}" }],
      ["PUT", "/api/streaming_import/clear_tables", { body: "{}", auth: null }],
      ["PUT", "/api/streaming_import/clear_tables", { body: '{"tableNames":5}' }],
      ["PUT", "/api/streaming_import/clear_tables", { body: '{"tableNames":["a",1]}' }],
      ["PUT", "/api/streaming_import/clear_tables", { body: '{"tableNames":null}' }],
      ["PUT", "/api/streaming_import/clear_tables", { body: '"x"' }],
      ["PUT", "/api/streaming_import/clear_tables", { body: "{" }],
      ["PUT", "/api/streaming_import/clear_tables", { body: "" }],
      ["POST", "/api/streaming_import/clear_tables", { body: '{"tableNames":[]}' }],
      ["GET", "/api/streaming_import/clear_tables", { contentType: null }],
      ["GET", "/api/streaming_import/get_schema", { auth: null, contentType: null }],
      ["POST", "/api/streaming_import/get_schema", { body: "{}" }],
      ["HEAD", "/api/streaming_import/get_schema", { contentType: null }],
      ["POST", "/api/streaming_import/replace_tables", { body: '{"tableNames":{"a":"b"}}', auth: null }],
      ["POST", "/api/streaming_import/replace_tables", { body: '{"tableNames":{"a":"b"}}' }],
      ["POST", "/api/streaming_import/replace_tables", { body: '{"tableNames":{"a":1}}' }],
      ["POST", "/api/streaming_import/replace_tables", { body: '{"tableNames":[]}' }],
      ["POST", "/api/streaming_import/replace_tables", { body: "{}" }],
      ["PUT", "/api/streaming_import/replace_tables", { body: "{}" }],
      ["GET", "/api/streaming_import/nope", { contentType: null }],
    ];
    for (const [method, path, opts] of cases) {
      const r = await both((b) => raw(b, method, path, opts));
      expect({ method, path, opts, ...r.bunvex }).toEqual({ method, path, opts, ...r.convex });
    }
  });

  test("the body limit: axum's default 2 MiB", async () => {
    const limit = 2 * 1024 * 1024;
    const body = (size: number) => {
      const head = '{"tableNames":[],"pad":"';
      return `${head}${"x".repeat(size - head.length - 2)}"}`;
    };
    for (const size of [limit, limit + 1]) {
      const r = await both((b) => raw(b, "PUT", "/api/streaming_import/clear_tables", { body: body(size) }));
      expect({ size, ...r.bunvex }).toEqual({ size, ...r.convex });
    }
  });

  test("get_schema: the active schema's JSON", async () => {
    const r = await both((b) => raw(b, "GET", "/api/streaming_import/get_schema", { contentType: null }));
    expect(r.bunvex).toEqual(r.convex);
    expect((r.convex.body as { tables: unknown[] }).tables).toHaveLength(2);
  });

  test("clear_tables: empty tables, indexes and numbers kept", async () => {
    const before = await both(async (b) => {
      const id = await insert(b, "a", { k: 1, n: 2 });
      await insert(b, "a", { k: 2 });
      await insert(b, "b", { x: 1 });
      return id;
    });
    const cleared = await both(clear(["a"]));
    expect(cleared.bunvex).toEqual(cleared.convex);
    const after = await both(async (b) => {
      const dump = (await value(b, "query", "ops:dump")) as Record<string, unknown[]>;
      return {
        a: dump.a!.length,
        b: dump.b!.length,
        // `by_k` is still there (a read by it fails otherwise).
        byK: await value(b, "query", "ops:read", { read: { table: "a", index: "by_k", range: [] } }),
        // The table kept its number: an id of before is an id of this table, of a document gone.
        old: await value(b, "mutation", "ops:apply", { ops: [{ kind: "get", id: before[b.name] }] }),
        // It takes documents again.
        again: (await insert(b, "a", { k: 3 })).length > 0,
      };
    });
    expect(after.bunvex).toEqual(after.convex);
    expect(after.convex).toEqual({ a: 0, b: 1, byK: [], old: [null], again: true });
  });

  test("clear_tables: names made valid, missing tables created, a name twice", async () => {
    const names: string[][] = [
      ["nope"],
      ["fresh_table"],
      ["_storage"],
      ["_scheduled_functions", "__x__"],
      ["My Table!"],
      ["Café Ünïcode 北亰 ½ ŒŠ"],
      ["日本語", "한국어", "Ελληνικά", "Русский", "עברית", "العربية"],
      ["ﬁ ß Ø Ð þ ĳ ǅ", " tab\tnew\nline", "₂ ³ ① Ⅻ"],
      ["😀 emoji \u{10400}", "￿", "￾"],
      ["$integer"],
      [""],
      ["___"],
      ["a", "a"],
      ["zz", "zz"],
      ["b", "zz", "b"],
      [],
      ["x".repeat(57)],
      ["x".repeat(58)],
      ["X".repeat(64)],
      ["X".repeat(65)],
      ["_".concat("x".repeat(57))],
      ["_".concat("x".repeat(58))],
      ["9lives"],
    ];
    for (const tableNames of names) {
      const r = await both(clear(tableNames));
      expect({ tableNames, ...r.bunvex }).toEqual({ tableNames, ...r.convex });
    }
    const t = await both(tables);
    expect(t.bunvex).toEqual(t.convex);
    expect(t.convex).toContain("source_cafe_unicode_bei_jing_1_2_oes");
  });

  test("clear_tables: transliteration across the Basic Multilingual Plane", async () => {
    // Every STEP-th code point from U+0080 to U+FFFE (surrogates left out), two to a numbered name (a
    // transliteration is at most 31 characters, so a pair's name stays valid), cleared in requests of 100 names;
    // every request must succeed on Convex, and the tables both made are compared. STEP is 16 by default
    // (about 100 s: each name is a table on both backends); `STREAMING_IMPORT_BMP_STEP=8` passed when this was
    // written (about 200 s, some 4 000 tables; Convex allows 10 000).
    const step = Number(process.env.STREAMING_IMPORT_BMP_STEP ?? 16);
    const cps: number[] = [];
    for (let cp = 0x80; cp < 0xffff; cp += step) if (cp < 0xd800 || cp > 0xdfff) cps.push(cp);
    const names: string[] = [];
    // Numbered, so no two names make the same table (a name repeated in a request is a `TableConflict`).
    for (let i = 0; i < cps.length; i += 2) names.push(`${i} ${String.fromCodePoint(...cps.slice(i, i + 2))}`);
    for (let i = 0; i < names.length; i += 100) {
      const r = await both(clear(names.slice(i, i + 100)));
      expect({ i, ...r.bunvex }).toEqual({ i, ...r.convex });
      expect(r.convex.status).toBe(200);
    }
    const t = await both(tables);
    expect(t.bunvex).toEqual(t.convex);
    expect(t.convex.length).toBeGreaterThan(cps.length / 2);
  }, 600_000);
});

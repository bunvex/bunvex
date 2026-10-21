// Query-string and body parse errors (`BadQueryArgs`, `BadJsonBody`) on Convex's backend (the oracle) and on
// bunvex's: every admin route that takes a query string or a JSON body, asked with missing, mistyped and
// malformed arguments, with and without a key; each error answer (status, code, message) compared, and a
// success compared by its status. Convex's extractors (`common/src/http/extract.rs`) read the query string and
// the body before the handler runs, so these errors come before the route's operation check. Not here: the app
// metrics and push routes (#559), `shapes2`'s `component` (bunvex has no components). Local only: skipped, with
// a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`parse-errors: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

let convex: Backend;
let bunvex: Backend;

type Case = { method: string; path: string; body?: string; auth?: boolean; contentType?: string | null };

/** Convex's wire names bunvex renamed (rule 5): DV-278's destinations and DV-308's metric. */
const RENAMES: [string, string][] = [
  ["convexCloud", "bunvexCloud"],
  ["convexSite", "bunvexSite"],
  ["actionComputeConvexGbHours", "actionComputeIsolateGbHours"],
];

async function raw(b: Backend, c: Case) {
  const headers: Record<string, string> = {};
  if (c.auth !== false) headers.authorization = `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;
  const ct = c.contentType === undefined ? (c.body === undefined ? null : "application/json") : c.contentType;
  if (ct !== null) headers["content-type"] = ct;
  let body = c.body;
  if (body !== undefined && b.name === "bunvex") for (const [from, to] of RENAMES) body = body.replaceAll(from, to);
  const r = await fetch(`${b.url}${c.path}`, {
    method: c.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  let text = await r.text();
  // `BadDeployKey`'s wording is #558's; until it merges bunvex names the deployment.
  text = text.replace(/invalid for deployment '[^']*'/, "invalid for this deployment");
  if (b.name === "convex") for (const [from, to] of RENAMES) text = text.replaceAll(from, to);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  // A success's body (a page, an id, a timestamp) is each backend's own: only its status is compared.
  return r.status === 200 ? { status: 200 } : { status: r.status, body: parsed };
}

/** The cases: each body route with a set of bodies, each query route with a set of query strings. */
function cases(): Case[] {
  const out: Case[] = [];
  const BODIES = ["{}", "[]", "5", "{", "", '{"x":1}', "null", '{"a":1,}'];
  const body = (method: string, path: string, extra: string[] = []) => {
    for (const b of [...BODIES, ...extra]) {
      out.push({ method, path, body: b });
      out.push({ method, path, body: b, auth: false });
    }
    out.push({ method, path, body: "{}", contentType: null });
    out.push({ method, path, body: "{}", contentType: "text/plain" });
  };
  const query = (path: string, qs: string[]) => {
    for (const q of qs) {
      out.push({ method: "GET", path: `${path}${q}` });
      out.push({ method: "GET", path: `${path}${q}`, auth: false });
    }
  };
  body("POST", "/api/cancel_job", ['{"id":5}', '{"id":"x","componentId":5}', '{"id":"x","id":"y"}']);
  body("POST", "/api/cancel_all_jobs", [
    '{"udfPath":5}',
    '{"startNextTs":"x"}',
    '{"endNextTs":-1}',
    '{"startNextTs":1.5}',
    '{"endNextTs":18446744073709551616}',
    "[null,null,null,null,null]",
    "[null]",
  ]);
  body("POST", "/api/delete_tables", ['{"tableNames":"a"}', '{"tableNames":[1]}', '{"tableNames":[],"componentId":5}']);
  body("POST", "/api/delete_scheduled_functions_table", ['{"componentId":5}']);
  for (const p of ["/api/update_canonical_url", "/api/v1/update_canonical_url"])
    body("POST", p, [
      '{"requestDestination":"x"}',
      '{"requestDestination":5}',
      '{"requestDestination":"convexCloud","url":5}',
      '{"requestDestination":"convexCloud","url":null}',
    ]);
  for (const p of ["/api/update_environment_variables", "/api/v1/update_environment_variables"])
    body("POST", p, [
      '{"changes":5}',
      '{"changes":[{"name":5}]}',
      '{"changes":[{}]}',
      '{"changes":[{"name":"A","value":1}]}',
    ]);
  body("POST", "/api/export/set_expiration/x", [
    '{"expirationTsNs":"x"}',
    '{"expirationTsNs":-1}',
    '{"expirationTsNs":1.5}',
  ]);
  body("POST", "/api/import/finish_upload", [
    '{"uploadToken":5}',
    '{"import":{},"uploadToken":"t","partTokens":[]}',
    '{"import":{"format":"nope"},"uploadToken":"t","partTokens":[]}',
    '{"import":{"format":"csv"},"uploadToken":"t","partTokens":[]}',
    '{"import":{"format":"zip","mode":"nope"},"uploadToken":"t","partTokens":[]}',
    '{"import":{"format":"csv","tableName":"a-b"},"uploadToken":"t","partTokens":[1]}',
  ]);
  body("POST", "/api/perform_import", ['{"importId":5}', '{"importId":"x"}']);
  body("POST", "/api/cancel_import", ['{"importId":5}', '{"importId":"x"}']);
  body("POST", "/api/v1/create_log_stream", [
    '{"logStreamType":"nope"}',
    '{"logStreamType":5}',
    '{"logStreamType":"webhook"}',
    '{"logStreamType":"webhook","url":5}',
    '{"logStreamType":"webhook","url":"x","format":"nope"}',
    '{"logStreamType":"datadog","siteLocation":"nope","ddApiKey":"k","ddTags":[]}',
    '{"logStreamType":"datadog","siteLocation":"US1","ddApiKey":"k","ddTags":5}',
    '{"logStreamType":"sentry","dsn":"x","tags":5}',
    '{"logStreamType":"webhook","url":"x","format":"json","topics":5}',
    '{"logStreamType":"axiom","apiKey":"k","datasetName":"d","attributes":5}',
  ]);
  body("POST", "/api/v1/create_usage_limit", [
    '{"metric":"nope","window":"day","limitType":"warning","limit":1,"enabled":true}',
    '{"metric":"functionCalls","window":"week","limitType":"warning","limit":1,"enabled":true}',
    '{"metric":"functionCalls","window":"day","limitType":"warning","limit":-1,"enabled":true}',
    '{"metric":"functionCalls","window":"day","limitType":"warning","limit":1,"enabled":"yes"}',
    '{"metric":"functionCalls","window":"day","limitType":"warning","limit":1}',
  ]);
  body("POST", "/api/v1/data/sync", ['{"selection":5}', '{"cursor":5}']);
  body("POST", "/api/data_sync_cursor_from_deltas", ['{"cursor":"x"}', '{"cursor":0,"selection":5}']);
  body("POST", "/api/list_snapshot", ['{"snapshot":"x"}', '{"tableName":5}', '{"selection":5}', '{"cursor":5}']);
  // No bad `format` with a cursor here: Convex checks it after the read, so whether cursor 0 is still in each
  // side's document window decides the answer (the server's streaming-export test covers the order).
  body("POST", "/api/document_deltas", ['{"cursor":"x"}', '{"cursor":0,"tableName":5}']);
  query("/api/v1/list_audit_log_events", [
    "",
    "?from=x",
    "?from=0&limit=x",
    "?from=-1",
    "?from=",
    "?from=0&limit=0",
    "?from=0&cursor=5",
    "?from=0&from=1",
    "?from=99999999999999999999",
  ]);
  query("/api/list_snapshot", ["?snapshot=x", "?cursor=", "?tableName=", "?format=nope", "?snapshot=-1", "?snapshot="]);
  query("/api/document_deltas", ["", "?cursor=x", "?cursor=-1", "?cursor=0&tableName="]);
  query("/api/json_schemas", ["?deltaSchema=x", "?format=nope", "?deltaSchema=true", "?byComponent=1"]);
  query("/api/v1/list_active_syncs", ["?limit=x", "?limit=0", "?limit=-1"]);
  for (const q of ["", "?format=nope", "?format=csv", "?format=zip&mode=nope", "?format=csv&tableName=a-b"])
    out.push({ method: "POST", path: `/api/import${q}`, body: "", contentType: null });
  for (const q of ["", "?uploadToken=t", "?uploadToken=t&partNumber=x", "?uploadToken=t&partNumber=70000"])
    out.push({ method: "POST", path: `/api/import/upload_part${q}`, body: "", contentType: null });
  return out;
}

describe.skipIf(!ready)("parse errors on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await startAll([startConvex(), startBunvex()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("each route's parse errors, with and without a key", async () => {
    const diffs: unknown[] = [];
    for (const c of cases()) {
      const conv = await raw(convex, c);
      // A route Convex does not have is not compared.
      if (conv.status === 404 && conv.body === "") continue;
      const bun = await raw(bunvex, c);
      if (JSON.stringify(bun) !== JSON.stringify(conv)) diffs.push({ ...c, convex: conv, bunvex: bun });
    }
    if (process.env.PARSE_ERRORS_OUT) await Bun.write(process.env.PARSE_ERRORS_OUT, JSON.stringify(diffs, null, 1));
    expect(diffs).toEqual([]);
  }, 120_000);
});

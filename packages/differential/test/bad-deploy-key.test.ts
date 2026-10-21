// `BadDeployKey` (403), on Convex's backend (the oracle) and on bunvex's: every admin route asked without a key,
// with a user's (non-admin) bearer token, and with a key in the body where the route takes one. Convex's
// `bad_admin_key_error(identity.instance_name())` (keybroker/src/operations.rs) names the deployment only for a
// `DeploymentAdmin` identity, which never reaches it: the routes answer "invalid for this deployment". Local
// only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`bad-deploy-key: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

let convex: Backend;
let bunvex: Backend;

async function raw(b: Backend, method: string, path: string, body?: string, auth?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth !== undefined) headers.authorization = auth;
  const r = await fetch(`${b.url}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: r.status, body: parsed };
}

/** The admin routes both backends serve, each with a body that gets past its argument checks where it can. */
const ROUTES: [string, string, string?][] = [
  ["GET", "/api/check_admin_key"],
  ["POST", "/api/delete_tables", '{"tableNames":[]}'],
  ["POST", "/api/delete_scheduled_functions_table", "{}"],
  ["POST", "/api/cancel_job", '{"id":"x"}'],
  ["POST", "/api/cancel_all_jobs", "{}"],
  ["GET", "/api/v1/list_audit_log_events?from=0"],
  ["GET", "/api/v1/get_canonical_urls"],
  ["POST", "/api/v1/update_canonical_url", '{"requestDestination":"convexCloud","url":null}'],
  ["GET", "/api/stream_function_logs?cursor=0"],
  ["GET", "/api/v1/list_log_streams"],
  ["GET", "/api/json_schemas"],
  ["GET", "/api/list_snapshot"],
  ["GET", "/api/document_deltas?cursor=0"],
  ["GET", "/api/test_streaming_export_connection"],
  ["GET", "/api/get_table_column_names"],
  ["GET", "/api/v1/list_active_syncs"],
  ["GET", "/api/shapes2"],
  ["POST", "/api/v1/pause_deployment", "{}"],
  ["POST", "/api/v1/unpause_deployment", "{}"],
  ["GET", "/api/v1/list_environment_variables"],
  ["POST", "/api/v1/update_environment_variables", '{"changes":[]}'],
  ["POST", "/api/update_environment_variables", '{"changes":[]}'],
  ["POST", "/api/export/request/zip", ""],
  ["POST", "/api/import/start_upload", ""],
];

describe.skipIf(!ready)("BadDeployKey on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await startAll([startConvex(), startBunvex()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("every admin route without a key: the same refusal", async () => {
    let refused = 0;
    for (const [method, path, body] of ROUTES) {
      const c = await raw(convex, method, path, body);
      // A route bunvex does not have (Convex's 404) is not this test's business.
      if (c.status === 404) continue;
      // The body names Convex's request destination; bunvex's is its own word (DV-312). Bodies are parsed
      // before the key is checked (#562), so each backend gets the name it knows, and both refuse on the key.
      const b = await raw(bunvex, method, path, body?.replace('"convexCloud"', '"bunvexCloud"'));
      if ((c.body as { code?: string }).code === "BadDeployKey") refused++;
      expect({ method, path, ...b }).toEqual({ method, path, ...c });
    }
    expect(refused).toBeGreaterThan(15);
  });

  test("a key in a push route's body that is not an admin key (Convex's `must_be_admin_from_key`)", async () => {
    for (const key of ["garbage", "", "prod:other|abc", "a|b"]) {
      const body = JSON.stringify({ adminKey: key });
      const r = {
        convex: await raw(convex, "POST", "/api/get_config_hashes", body),
        bunvex: await raw(bunvex, "POST", "/api/get_config_hashes", body),
      };
      expect({ key, ...r.bunvex }).toEqual({ key, ...r.convex });
      const tester = JSON.stringify({
        adminKey: key,
        bundle: { path: "testQuery.js", source: "export default 1;" },
        args: {},
        format: "json",
      });
      const t = {
        convex: await raw(convex, "POST", "/api/run_test_function", tester),
        bunvex: await raw(bunvex, "POST", "/api/run_test_function", tester),
      };
      expect({ key, tester: true, ...t.bunvex }).toEqual({ key, tester: true, ...t.convex });
    }
  });

  test("a user's token where an admin is required", async () => {
    // Not a valid token on either backend: the header's own error, before the route's.
    const r = {
      convex: await raw(convex, "GET", "/api/check_admin_key", undefined, "Bearer abc"),
      bunvex: await raw(bunvex, "GET", "/api/check_admin_key", undefined, "Bearer abc"),
    };
    expect(r.bunvex).toEqual(r.convex);
  });
});

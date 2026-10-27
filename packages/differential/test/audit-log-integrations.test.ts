// The deployment audit log's integration and export download events (Convex's 3a958a4, 8281a65, 9d26926;
// STUDY-186 A12), on Convex's backend (the oracle) and on bunvex's: every log stream type created, updated (a
// credential and a plain field), a webhook's secret rotated, each deleted; then an export downloaded with the admin
// key and with a download token. Convex's binary does not list its audit log (`AuditLogsDisabled` on a self-hosted
// plan), so its store is opened by bunvex afterwards and listed there (the rows as Convex wrote them; STUDY-133's
// cross-open). Compared: each event's action, actor and metadata, ids mapped in order. Local only: skipped, with a
// note, when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, newStore, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready)
  console.warn(`audit-log-integrations: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

let convex: Backend;
let bunvex: Backend;
const store = newStore();

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ store }), startBunvex()]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const authOf = (b: Backend) => `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;

async function req(b: Backend, method: string, path: string, body?: unknown, auth = true) {
  const r = await fetch(`${b.url}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: authOf(b) } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  // biome-ignore lint/suspicious/noExplicitAny: the API's JSON
  return { status: r.status, body: parsed as any };
}

const CREATES = [
  {
    logStreamType: "webhook",
    url: "https://user:pw@hooks.example.com:8443/path/x?token=1#f",
    format: "jsonl",
    topics: ["audit_log", "console"],
  },
  { logStreamType: "datadog", siteLocation: "US1", ddApiKey: "k1", ddTags: ["a:b"], service: "svc" },
  {
    logStreamType: "axiom",
    apiKey: "k1",
    datasetName: "ds",
    attributes: [{ key: "k", value: "v" }],
    ingestUrl: "https://eu-central-1.aws.edge.axiom.co",
  },
  { logStreamType: "sentry", dsn: "https://pub@o1.ingest.sentry.io/123", tags: { t: "v" } },
  { logStreamType: "postHogLogs", apiKey: "k1", host: "https://eu.posthog.com/a", serviceName: "s" },
  { logStreamType: "postHogErrorTracking", apiKey: "k1" },
  {
    logStreamType: "s3Export",
    bucket: "bkt",
    region: "us-east-1",
    prefix: "p/",
    accessKeyId: "AK",
    secretAccessKey: "SK",
    period: "hourly",
  },
];
const UPDATES: Record<string, object> = {
  webhook: { logStreamType: "webhook", url: "https://hooks.example.com/other" },
  datadog: { logStreamType: "datadog", ddApiKey: "k2", service: null },
  axiom: { logStreamType: "axiom", datasetName: "ds2", ingestUrl: "https://api.axiom.co" },
  sentry: { logStreamType: "sentry", dsn: "https://pub2@o1.ingest.sentry.io/456" },
  postHogLogs: { logStreamType: "postHogLogs", apiKey: "k2" },
  postHogErrorTracking: { logStreamType: "postHogErrorTracking", host: "https://us.i.posthog.com" },
  s3Export: { logStreamType: "s3Export", period: "daily", secretAccessKey: "SK2" },
};

async function play(b: Backend) {
  for (const c of CREATES) {
    const r = await req(b, "POST", "/api/v1/create_log_stream", c);
    expect({ c: c.logStreamType, status: r.status }).toEqual({ c: c.logStreamType, status: 200 });
    const u = await req(b, "POST", `/api/v1/update_log_stream/${r.body.id}`, UPDATES[c.logStreamType]);
    expect({ c: c.logStreamType, status: u.status }).toEqual({ c: c.logStreamType, status: 200 });
    if (c.logStreamType === "webhook") await req(b, "POST", `/api/v1/rotate_webhook_secret/${r.body.id}`, {});
    await req(b, "POST", `/api/v1/delete_log_stream/${r.body.id}`, {});
  }
  // An export, downloaded with the admin key, then with a token.
  expect((await req(b, "POST", "/api/export/request/zip?includeStorage=false")).status).toBe(200);
  let id: string | undefined;
  for (let i = 0; i < 400 && !id; i++) {
    const r = await req(b, "POST", "/api/query", { path: "_system/frontend/latestExport", args: {}, format: "json" });
    if (r.body.value?.state === "completed") id = r.body.value._id;
    else await Bun.sleep(50);
  }
  expect((await fetch(`${b.url}/api/export/zip/${id}`, { headers: { authorization: authOf(b) } })).status).toBe(200);
  const token = (await req(b, "POST", `/api/export/zip/${id}/token`)).body.token as string;
  expect((await fetch(`${b.url}/api/export/zip/${id}?token=${encodeURIComponent(token)}`)).status).toBe(200);
}

/** The events this test made, ids mapped to their order of appearance. */
async function events(reader: Backend) {
  const r = await req(reader, "GET", "/api/v1/list_audit_log_events?from=0&limit=100");
  expect(r.status).toBe(200);
  const ids = new Map<string, string>();
  const ofId = (v: string) => (ids.has(v) ? ids.get(v)! : (ids.set(v, `id${ids.size}`), `id${ids.size - 1}`));
  // biome-ignore lint/suspicious/noExplicitAny: the API's JSON
  return (r.body.items as any[])
    .filter((e) => /integration|export/.test(e.action))
    .map((e) => ({ action: e.action, actor: e.actor, metadata: { ...e.metadata, id: ofId(e.metadata.id) } }));
}

describe.skipIf(!ready)("the audit log's integration and export download events, against Convex's backend", () => {
  test("each event's action, actor and metadata", async () => {
    await play(convex);
    await play(bunvex);
    await convex.stop();
    const reader = await startBunvex({ store });
    try {
      const c = await events(reader);
      const b = await events(bunvex);
      expect(b).toEqual(c);
      expect(c.map((e) => e.action)).toEqual([
        ...["webhook", "datadog", "axiom", "sentry", "postHogLogs", "postHogErrorTracking", "s3Export"].flatMap((t) =>
          t === "webhook"
            ? ["create_integration", "update_integration", "update_integration", "delete_integration"]
            : ["create_integration", "update_integration", "delete_integration"],
        ),
        "request_export",
        "download_export",
        "download_export",
      ]);
    } finally {
      await reader.stop();
    }
  }, 300_000);
});

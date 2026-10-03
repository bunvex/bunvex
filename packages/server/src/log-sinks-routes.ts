// Convex's log stream API (crates/local_backend/src/log_sinks.rs, STUDY-59): under `/api/v1/`,
// `list_log_streams` and `get_log_stream/{id}` (ViewIntegrations); `create_log_stream`,
// `update_log_stream/{id}`, `delete_log_stream/{id}` and `rotate_webhook_secret/{id}` (WriteIntegrations), each
// change with its audit event. Every sink type's arguments are checked as Convex's; bunvex runs webhook,
// local and S3 export sinks (DV-303).

import type { Caller } from "@bunvex/core";
import { type Engine, insertAuditLogEvents, type Tx } from "@bunvex/core";
import { auditActor, auditEvents } from "./audit-log.ts";
import type { Functions } from "./functions.ts";
import { type LogTopic, SUBSCRIBABLE_TOPICS } from "./log-events.ts";
import {
  addOrUpdateSink,
  LogSinkError,
  listSinks,
  mustGetSink,
  newWebhookSecret,
  patchSink,
  SINK_TYPE_NAMES,
  type SinkConfig,
  type SinkRow,
  type SinkType,
  sinkOfType,
} from "./log-sinks.ts";

/** `/api/v1/<route>[/<id>]`. */
export const LOG_STREAM_ROUTE =
  /^\/api\/v1\/(list_log_streams|get_log_stream|create_log_stream|update_log_stream|delete_log_stream|rotate_webhook_secret)(?:\/([^/]+))?$/;

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const AXIOM_INGEST_URLS = [
  "https://api.axiom.co",
  "https://us-east-1.aws.edge.axiom.co",
  "https://eu-central-1.aws.edge.axiom.co",
];
const DATADOG_SITES = ["US1", "US3", "US5", "EU", "US1_FED", "AP1"];
const AXIOM_MAX_ATTRIBUTES = 1024;

/** The API's sink types (Convex's `logStreamType`); `local` is not one. */
const API_TYPES: readonly SinkType[] = [
  "datadog",
  "webhook",
  "axiom",
  "sentry",
  "postHogLogs",
  "postHogErrorTracking",
  "s3Export",
];

const bad = (code: string, message: string) => new LogSinkError(400, code, message);
const badBody = (message: string) => bad("BadJsonBody", message);

type Body = Record<string, unknown>;

// ---- argument checks (serde's, then Convex's validations)

function str(b: Body, k: string, optional: true): string | null | undefined;
function str(b: Body, k: string, optional?: false): string;
function str(b: Body, k: string, optional = false) {
  const v = b[k];
  if (v === undefined) {
    if (optional) return undefined;
    throw badBody(`missing field \`${k}\``);
  }
  if (v === null && optional) return null;
  if (typeof v !== "string") throw badBody(`${k}: invalid type: expected a string`);
  return v;
}

function topicsArg(b: Body): LogTopic[] | null | undefined {
  const v = b.topics;
  if (v === undefined || v === null) return v as undefined | null;
  if (!Array.isArray(v) || !v.every((t) => typeof t === "string"))
    throw badBody("topics: invalid type: expected a sequence");
  return v as LogTopic[];
}

/** Convex's topic checks: not empty, each subscribable; `custom_audit` needs an entitlement no self-hosted deployment has. */
function checkTopics(topics: LogTopic[] | null | undefined) {
  if (topics === undefined || topics === null) return;
  if (topics.length === 0) throw bad("EmptyLogTopics", "A log stream must be subscribed to at least one topic.");
  for (const t of topics)
    if (!SUBSCRIBABLE_TOPICS.includes(t))
      throw bad("InvalidLogTopic", `Log stream topic \`${t}\` cannot be subscribed to`);
  if (topics.includes("custom_audit"))
    throw new LogSinkError(
      403,
      "CustomAuditLogsInLogStreamsNotEnabled",
      "Subscribing a log stream to the custom_audit topic is not available on this deployment.",
    );
}

const isUrl = (s: string) => {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
};

function checkWebhookUrl(url: string) {
  if (!isUrl(url)) throw bad("InvalidWebhookUrl", "The URL passed was invalid");
}

function checkFormat(f: string) {
  if (f !== "json" && f !== "jsonl") throw badBody(`format: unknown variant \`${f}\`, expected \`json\` or \`jsonl\``);
}

function checkSite(s: string) {
  if (!DATADOG_SITES.includes(s)) throw badBody(`siteLocation: unknown variant \`${s}\``);
}

function checkIngestUrl(u: string | null | undefined) {
  if (u !== undefined && u !== null && !AXIOM_INGEST_URLS.includes(u))
    throw bad(
      "InvalidAxiomIngestUrl",
      `Invalid Axiom ingest URL: ${u}. Must be one of: ${AXIOM_INGEST_URLS.join(", ")}`,
    );
}

function checkAttributes(a: unknown): { key: string; value: string }[] {
  if (!Array.isArray(a) || !a.every((x) => x && typeof x.key === "string" && typeof x.value === "string"))
    throw badBody("attributes: invalid type: expected a sequence of {key, value}");
  if (a.length > AXIOM_MAX_ATTRIBUTES) throw new Error("Exceeded max number of Axiom attributes.");
  return a;
}

/** A Sentry DSN: `<scheme>://<key>@<host>/<project id>`. */
function checkDsn(dsn: string) {
  try {
    const u = new URL(dsn);
    if (!u.username || !/^\/(?:.*\/)?\d+$/.test(u.pathname)) throw new Error();
  } catch {
    throw bad("InvalidSentryDsn", "The Sentry DSN passed was invalid");
  }
}

function checkHost(h: string | null | undefined) {
  if (h !== undefined && h !== null && !isUrl(h)) throw bad("InvalidPostHogHost", `Invalid PostHog host URL: ${h}`);
}

function checkBucket(b: string) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b) || b.includes(".."))
    throw bad("InvalidS3Bucket", `\`${b}\` is not a valid S3 bucket name`);
}

function stringRecord(v: unknown, k: string): Record<string, string> | null | undefined {
  if (v === undefined || v === null) return v as undefined | null;
  if (typeof v !== "object" || Array.isArray(v) || !Object.values(v).every((x) => typeof x === "string"))
    throw badBody(`${k}: invalid type: expected a map`);
  return v as Record<string, string>;
}

/** Drop `undefined` and `null` optional fields (Convex skips them when serializing). */
// biome-ignore lint/suspicious/noExplicitAny: the cleaned object is a stored config
const clean = (o: Record<string, unknown>): any =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/** A new sink's config from `create_log_stream`'s body. */
function createConfig(b: Body): SinkConfig {
  const type = b.logStreamType;
  switch (type) {
    case "webhook": {
      const url = str(b, "url");
      const format = str(b, "format");
      checkFormat(format);
      const topics = topicsArg(b);
      checkWebhookUrl(url);
      checkTopics(topics);
      return clean({ type, url, format: format as "json" | "jsonl", hmacSecret: newWebhookSecret(), topics });
    }
    case "datadog": {
      const siteLocation = str(b, "siteLocation");
      checkSite(siteLocation);
      const ddApiKey = str(b, "ddApiKey");
      if (!Array.isArray(b.ddTags) || !b.ddTags.every((t) => typeof t === "string"))
        throw badBody(b.ddTags === undefined ? "missing field `ddTags`" : "ddTags: invalid type: expected a sequence");
      const topics = topicsArg(b);
      checkTopics(topics);
      return clean({
        type,
        siteLocation,
        ddApiKey,
        ddTags: b.ddTags,
        version: "2",
        service: str(b, "service", true),
        topics,
      });
    }
    case "axiom": {
      const apiKey = str(b, "apiKey");
      const datasetName = str(b, "datasetName");
      if (b.attributes === undefined) throw badBody("missing field `attributes`");
      const attributes = checkAttributes(b.attributes);
      const ingestUrl = str(b, "ingestUrl", true);
      const topics = topicsArg(b);
      checkIngestUrl(ingestUrl);
      checkTopics(topics);
      return clean({ type, apiKey, datasetName, attributes, version: "2", ingestUrl, topics });
    }
    case "sentry": {
      const dsn = str(b, "dsn");
      checkDsn(dsn);
      return clean({ type, dsn, tags: stringRecord(b.tags, "tags"), version: "2" });
    }
    case "postHogLogs": {
      const apiKey = str(b, "apiKey");
      const host = str(b, "host", true);
      const topics = topicsArg(b);
      checkHost(host);
      checkTopics(topics);
      return clean({ type, apiKey, host, serviceName: str(b, "serviceName", true), topics });
    }
    case "postHogErrorTracking": {
      const apiKey = str(b, "apiKey");
      const host = str(b, "host", true);
      checkHost(host);
      return clean({ type, apiKey, host });
    }
    case "s3Export": {
      const bucket = str(b, "bucket");
      const region = str(b, "region");
      const accessKeyId = str(b, "accessKeyId");
      const secretAccessKey = str(b, "secretAccessKey");
      const period = str(b, "period");
      if (!["continuous", "hourly", "daily"].includes(period)) throw badBody(`period: unknown variant \`${period}\``);
      checkBucket(bucket);
      return clean({
        type,
        bucket,
        region,
        prefix: str(b, "prefix", true),
        accessKeyId,
        secretAccessKey,
        selection: b.selection ?? null,
        period,
      });
    }
  }
  if (type === undefined) throw badBody("missing field `logStreamType`");
  throw badBody(`unknown variant \`${String(type)}\``);
}

/** Convex's per-type mismatch wording. */
const MISMATCH: Record<SinkType, string> = {
  datadog: "Cannot update a Datadog log stream with arguments for a different log stream type",
  webhook: "Cannot update a Webhook log stream with arguments for a different log stream type",
  axiom: "Cannot update an Axiom log stream with arguments for a different log stream type",
  sentry: "Cannot update a Sentry log stream with arguments for a different log stream type",
  postHogLogs: "Cannot update a PostHog Logs log stream with arguments for a different log stream type",
  postHogErrorTracking:
    "Cannot update a PostHog Error Tracking log stream with arguments for a different log stream type",
  s3Export: "Cannot update an S3 export integration with arguments for a different integration type",
  local: "This log stream type does not support updates",
};

/** `update_log_stream`: each field given replaces the stored one; `null` unsets an optional one. */
function updatedConfig(old: SinkConfig, b: Body): SinkConfig {
  if (old.type === "local") throw bad("UnsupportedLogStreamType", "This log stream type does not support updates");
  if (b.logStreamType === undefined) throw badBody("missing field `logStreamType`");
  if (!API_TYPES.includes(b.logStreamType as SinkType)) throw badBody(`unknown variant \`${String(b.logStreamType)}\``);
  if (b.logStreamType !== old.type) throw bad("LogStreamTypeMismatch", MISMATCH[old.type]);
  const next: Record<string, unknown> = { ...old };
  const set = (k: string, v: unknown) => {
    if (v === undefined) return;
    if (v === null) delete next[k];
    else next[k] = v;
  };
  const keep = (k: string) => (b[k] === undefined ? undefined : str(b, k));
  switch (old.type) {
    case "webhook": {
      set("url", keep("url"));
      const format = keep("format");
      if (format !== undefined) checkFormat(format);
      set("format", format);
      set("topics", topicsArg(b));
      checkWebhookUrl(next.url as string);
      checkTopics(next.topics as LogTopic[] | undefined);
      break;
    }
    case "datadog": {
      const site = keep("siteLocation");
      if (site !== undefined) checkSite(site);
      set("siteLocation", site);
      set("ddApiKey", keep("ddApiKey"));
      if (b.ddTags !== undefined) set("ddTags", b.ddTags);
      set("service", str(b, "service", true));
      set("topics", topicsArg(b));
      checkTopics(next.topics as LogTopic[] | undefined);
      break;
    }
    case "axiom": {
      set("apiKey", keep("apiKey"));
      set("datasetName", keep("datasetName"));
      if (b.attributes !== undefined) set("attributes", checkAttributes(b.attributes));
      set("ingestUrl", str(b, "ingestUrl", true));
      set("topics", topicsArg(b));
      checkIngestUrl(next.ingestUrl as string | undefined);
      checkTopics(next.topics as LogTopic[] | undefined);
      break;
    }
    case "sentry": {
      set("dsn", keep("dsn"));
      set("tags", stringRecord(b.tags, "tags"));
      checkDsn(next.dsn as string);
      break;
    }
    case "postHogLogs": {
      set("apiKey", keep("apiKey"));
      set("host", str(b, "host", true));
      set("serviceName", str(b, "serviceName", true));
      set("topics", topicsArg(b));
      checkHost(next.host as string | undefined);
      checkTopics(next.topics as LogTopic[] | undefined);
      break;
    }
    case "postHogErrorTracking": {
      set("apiKey", keep("apiKey"));
      set("host", str(b, "host", true));
      checkHost(next.host as string | undefined);
      break;
    }
    case "s3Export": {
      for (const k of ["bucket", "region", "accessKeyId", "secretAccessKey", "period"]) set(k, keep(k));
      set("prefix", str(b, "prefix", true));
      if (b.selection !== undefined) set("selection", b.selection);
      checkBucket(next.bucket as string);
      break;
    }
  }
  return next as SinkConfig;
}

/** A row as `list_log_streams` / `get_log_stream` answer it (Convex's `LogStreamConfig`): no API keys. */
export function logStreamJson(r: SinkRow): Record<string, unknown> | null {
  const c = r.config as Record<string, unknown> & { type: SinkType };
  const base = { id: r._id, status: r.status };
  const topics = c.topics ?? null;
  switch (c.type) {
    case "webhook":
      return { logStreamType: "webhook", ...base, url: c.url, format: c.format, hmacSecret: c.hmacSecret, topics };
    case "datadog":
      return {
        ...clean({
          logStreamType: "datadog",
          ...base,
          siteLocation: c.siteLocation,
          ddTags: c.ddTags,
          service: c.service,
        }),
        topics,
      };
    case "axiom":
      return {
        ...clean({
          logStreamType: "axiom",
          ...base,
          datasetName: c.datasetName,
          attributes: c.attributes,
          ingestUrl: c.ingestUrl,
        }),
        topics,
      };
    case "sentry":
      return clean({ logStreamType: "sentry", ...base, tags: c.tags });
    case "postHogLogs":
      return {
        ...clean({
          logStreamType: "postHogLogs",
          ...base,
          host: c.host ?? DEFAULT_POSTHOG_HOST,
          serviceName: c.serviceName,
        }),
        topics,
      };
    case "postHogErrorTracking":
      return { logStreamType: "postHogErrorTracking", ...base, host: c.host ?? DEFAULT_POSTHOG_HOST };
    case "s3Export":
      return {
        logStreamType: "s3Export",
        ...base,
        bucket: c.bucket,
        region: c.region,
        prefix: c.prefix ?? null,
        accessKeyId: c.accessKeyId,
        selection: c.selection ?? null,
        period: c.period,
      };
    case "local":
      return null;
  }
}

/** The routes. `wake`: run the log manager's worker after a change. */
export async function logStreamRoute(
  deps: { engine: Engine; functions: Functions; wake: () => void },
  route: string,
  id: string | undefined,
  req: Request,
  caller: Caller,
): Promise<Response> {
  const { engine, functions } = deps;
  const json = (body: unknown) => Response.json(body);
  const needId = () => {
    if (id === undefined) throw new LogSinkError(404, "NotFound", `no route for /api/v1/${route}`);
    return decodeURIComponent(id);
  };
  const body = async (): Promise<Body> => {
    let b: unknown;
    try {
      b = await req.json();
    } catch (e) {
      throw badBody(`Failed to parse the request body as JSON: ${(e as Error).message}`);
    }
    if (b === null || typeof b !== "object" || Array.isArray(b)) throw badBody("invalid type: expected an object");
    return b as Body;
  };
  const audit = (db: Tx, event: ReturnType<typeof auditEvents.createIntegration>) =>
    insertAuditLogEvents(db, [event], auditActor(caller));
  switch (route) {
    case "list_log_streams": {
      if (req.method !== "GET") break;
      functions.requireOperation(caller, "ViewIntegrations");
      const all = await engine.query((db) => listSinks(db));
      return json(all.map(logStreamJson).filter((x) => x !== null));
    }
    case "get_log_stream": {
      if (req.method !== "GET") break;
      functions.requireOperation(caller, "ViewIntegrations");
      const sinkId = needId();
      const row = await engine.query((db) => mustGetSink(db, sinkId));
      const out = logStreamJson(row);
      if (!out) throw bad("UnsupportedLogStreamType", "This log stream type is not supported");
      return json(out);
    }
    case "create_log_stream": {
      if (req.method !== "POST") break;
      functions.requireOperation(caller, "WriteIntegrations");
      const b = await body();
      const type = b.logStreamType;
      if (typeof type === "string" && API_TYPES.includes(type as SinkType)) {
        const existing = await engine.query((db) => sinkOfType(db, type as SinkType));
        if (existing)
          throw new LogSinkError(
            409,
            "LogStreamAlreadyExists",
            `${SINK_TYPE_NAMES[type as SinkType]} log stream already exists for this deployment`,
          );
      }
      const config = createConfig(b);
      const newId = await engine.mutation(async (db) => {
        const sinkId = await addOrUpdateSink(db, config);
        await audit(db, auditEvents.createIntegration(sinkId, config.type));
        return sinkId;
      }, "create_log_stream");
      deps.wake();
      return json(
        config.type === "webhook"
          ? { logStreamType: "webhook", id: newId, hmacSecret: config.hmacSecret }
          : { logStreamType: config.type, id: newId },
      );
    }
    case "update_log_stream": {
      if (req.method !== "POST") break;
      functions.requireOperation(caller, "WriteIntegrations");
      const sinkId = needId();
      const b = await body();
      await engine.mutation(async (db) => {
        const row = await mustGetSink(db, sinkId);
        const config = updatedConfig(row.config, b);
        await patchSink(db, row._id, { config });
        await audit(db, auditEvents.updateIntegration(sinkId, row.config.type));
        // Verified again (Convex's `reset_log_sink_to_pending`).
        await patchSink(db, row._id, { status: { type: "pending" } });
      }, "update_log_stream");
      deps.wake();
      return new Response(null, { status: 200 });
    }
    case "delete_log_stream": {
      if (req.method !== "POST") break;
      functions.requireOperation(caller, "WriteIntegrations");
      const sinkId = needId();
      await engine.mutation(async (db) => {
        const row = await mustGetSink(db, sinkId);
        await patchSink(db, row._id, { status: { type: "deleting" } });
        await audit(db, auditEvents.deleteIntegration(row._id, row.config.type));
      }, "delete_log_stream");
      deps.wake();
      return new Response(null, { status: 200 });
    }
    case "rotate_webhook_secret": {
      if (req.method !== "POST") break;
      functions.requireOperation(caller, "WriteIntegrations");
      const sinkId = needId();
      const secret = await engine.mutation(async (db) => {
        const row = await mustGetSink(db, sinkId);
        if (row.config.type !== "webhook")
          throw bad("NoSecretToRotate", "This log stream does not have a secret to rotate.");
        const hmacSecret = newWebhookSecret();
        await patchSink(db, row._id, { config: { ...row.config, hmacSecret } });
        await audit(db, auditEvents.updateIntegration(sinkId, "webhook"));
        return hmacSecret;
      }, "rotate_webhook_secret");
      // As Convex's, the running sink keeps signing with the old secret until it restarts.
      return json({ logStreamType: "webhook", hmacSecret: secret });
    }
  }
  return Response.json({ code: "NotFound", message: `no route for /api/v1/${route}` }, { status: 404 });
}

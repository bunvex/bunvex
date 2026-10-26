// Convex's log stream API (crates/local_backend/src/log_sinks.rs, STUDY-59): under `/api/v1/`,
// `list_log_streams` and `get_log_stream/{id}` (ViewIntegrations); `create_log_stream`,
// `update_log_stream/{id}`, `delete_log_stream/{id}` and `rotate_webhook_secret/{id}` (WriteIntegrations; an
// S3 export's create and update also ViewData, since Convex 4933aa2), each
// change with its audit event. Every sink type's arguments are checked as Convex's; bunvex runs webhook,
// local and S3 export sinks (DV-303).

import type { Caller } from "@bunvex/core";
import { type Engine, insertAuditLogEvents, knob, type Tx } from "@bunvex/core";
import { auditActor, auditEvents } from "./audit-log.ts";
import type { Functions } from "./functions.ts";
import { BadJsonBody, checkJsonBody } from "./json-body.ts";
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
import { parseDsn } from "./log-sinks-providers.ts";

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
const AXIOM_MAX_ATTRIBUTES = knob("AXIOM_MAX_ATTRIBUTES", 1024);

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
/** serde's error for a variant's own field (its content buffered, so no position), as axum words it. */
const badBody = (message: string) =>
  bad("BadJsonBody", `Failed to deserialize the JSON body into the target type: ${message}`);

/** How serde names a value it did not expect (`invalid type: <this>, expected …`; a JSON `null` is `null`). */
function unexpected(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return `string ${JSON.stringify(v)}`;
  if (typeof v === "boolean") return `boolean \`${v}\``;
  if (typeof v === "number") return Number.isInteger(v) ? `integer \`${v}\`` : `floating point \`${v}\``;
  if (Array.isArray(v)) return "sequence";
  return "map";
}

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
  if (typeof v !== "string") throw badBody(`invalid type: ${unexpected(v)}, expected a string`);
  return v;
}

function topicsArg(b: Body): LogTopic[] | null | undefined {
  const v = b.topics;
  if (v === undefined || v === null) return v as undefined | null;
  if (!Array.isArray(v) || !v.every((t) => typeof t === "string"))
    throw badBody(`invalid type: ${unexpected(v)}, expected a sequence`);
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
  if (f !== "json" && f !== "jsonl") throw badBody(`unknown variant \`${f}\`, expected \`json\` or \`jsonl\``);
}

function checkSite(s: string) {
  if (!DATADOG_SITES.includes(s)) throw unknownVariant(s, DATADOG_SITES);
}

function checkIngestUrl(u: string | null | undefined) {
  if (u !== undefined && u !== null && !AXIOM_INGEST_URLS.includes(u))
    throw bad(
      "InvalidAxiomIngestUrl",
      `Invalid Axiom ingest URL: ${u}. Must be one of: ${AXIOM_INGEST_URLS.join(", ")}`,
    );
}

function attributesArg(a: unknown): { key: string; value: string }[] {
  if (!Array.isArray(a) || !a.every((x) => x && typeof x.key === "string" && typeof x.value === "string"))
    throw badBody(`invalid type: ${unexpected(a)}, expected a sequence`);
  return a;
}

function checkAttributes(a: { key: string; value: string }[]) {
  if (a.length > AXIOM_MAX_ATTRIBUTES) throw new Error("Exceeded max number of Axiom attributes.");
  return a;
}

/** A Sentry DSN, parsed as the Sentry SDK parses it (any project id segment, STUDY-70). */
function checkDsn(dsn: string) {
  try {
    parseDsn(dsn);
  } catch {
    throw bad("InvalidSentryDsn", "The Sentry DSN passed was invalid");
  }
}

function checkHost(h: string | null | undefined) {
  if (h !== undefined && h !== null && !isUrl(h)) throw bad("InvalidPostHogHost", `Invalid PostHog host URL: ${h}`);
}

// ---- S3 export (Convex's `CreateS3ExportLogStreamArgs`, `UpdateS3ExportSinkArgs`, `validate_s3_bucket` and
// `validate_s3_selection` in local_backend/src/log_sinks.rs; `Selection` in common/src/types/streaming_export)

/** AWS's reserved bucket name prefixes and suffixes (Convex's `S3_RESERVED_BUCKET_PREFIXES` / `_SUFFIXES`). */
const RESERVED_BUCKET_PREFIXES = ["xn--", "sthree-"];
const RESERVED_BUCKET_SUFFIXES = ["-s3alias", "--ol-s3"];

/** Whether `s` reads as an IPv4 address as Rust's `Ipv4Addr` parses one: four decimal octets, no leading zero. */
function isIpv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
}

/** AWS's bucket naming rules, as Convex checks them. */
function checkBucket(b: string) {
  const valid =
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b) &&
    !b.includes("..") &&
    !isIpv4(b) &&
    !RESERVED_BUCKET_PREFIXES.some((p) => b.startsWith(p)) &&
    !RESERVED_BUCKET_SUFFIXES.some((x) => b.endsWith(x));
  if (!valid) throw bad("InvalidS3Bucket", `\`${b}\` is not a valid S3 bucket name`);
}

const INCLUSIONS = ["excl", "excluded", "incl", "included"];
const EXCLUDED_TAG = ["excl", "excluded"];
const PERIODS = ["continuous", "hourly", "daily"];

/** serde's `unknown variant` wording: `a`, `a` or `b`, one of `a`, `b`, `c`. */
function unknownVariant(name: string, variants: readonly string[]) {
  const q = variants.map((x) => `\`${x}\``);
  const expected = q.length === 1 ? q[0] : q.length === 2 ? `${q[0]} or ${q[1]}` : `one of ${q.join(", ")}`;
  return badBody(`unknown variant \`${name}\`, expected ${expected}`);
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A unit variant as serde reads an enum: its name, or a map of its name to `null`. */
function unitVariant(v: unknown, variants: readonly string[]): string {
  if (isMap(v)) {
    const entries = Object.entries(v);
    if (entries.length !== 1) throw badBody("invalid value: map, expected map with a single key");
    const [name, inner] = entries[0]!;
    if (!variants.includes(name)) throw unknownVariant(name, variants);
    if (inner !== null) throw badBody(`invalid type: ${unexpected(inner)}, expected unit`);
    return name;
  }
  if (typeof v !== "string") throw badBody(`invalid type: ${unexpected(v)}, expected string or map`);
  if (!variants.includes(v)) throw unknownVariant(v, variants);
  return v;
}

type Inclusion = "included" | "excluded";
const inclusion = (v: unknown): Inclusion => (unitVariant(v, INCLUSIONS).startsWith("incl") ? "included" : "excluded");

/** A level of a selection: each entry by name, and `_other` for the rest. */
type Level = { [name: string]: Level | Inclusion };

/** A map of entries beside `_other` (serde's `flatten`): `_other` as it comes, then each entry in order. */
function flattened(v: Record<string, unknown>, entry: (x: unknown) => Level | Inclusion): Level {
  let other: Inclusion | undefined;
  const rest: [string, unknown][] = [];
  for (const [k, x] of Object.entries(v)) {
    if (k === "_other") other = inclusion(x);
    else rest.push([k, x]);
  }
  if (other === undefined) throw badBody("missing field `_other`");
  const out: Level = {};
  for (const [k, x] of rest) out[k] = entry(x);
  out._other = other;
  return out;
}

/** An untagged enum of `Included { …, _other }` and the `excluded` tag: the first that reads. */
function includedOrExcluded(name: string, v: unknown, entry: (x: unknown) => Level | Inclusion): Level | Inclusion {
  if (isMap(v))
    try {
      return flattened(v, entry);
    } catch (e) {
      if (!(e instanceof LogSinkError)) throw e;
    }
  try {
    unitVariant(v, EXCLUDED_TAG);
    return "excluded";
  } catch (e) {
    if (!(e instanceof LogSinkError)) throw e;
    throw badBody(`data did not match any variant of untagged enum ${name}`);
  }
}

/** Convex's `Selection`: components, each with its tables, each with its columns. */
function selectionArg(v: unknown): Level {
  if (!isMap(v)) throw badBody(`invalid type: ${unexpected(v)}, expected struct Selection`);
  const table = (t: unknown) => includedOrExcluded("TableSelection", t, inclusion);
  return flattened(v, (c) => includedOrExcluded("ComponentSelection", c, table));
}

/** `validate_s3_selection`: an export takes whole tables, so a table that leaves out a column is refused. */
function checkWholeTables(selection: Level) {
  const tables = Object.entries(selection).flatMap(([k, c]) =>
    k === "_other" || typeof c === "string" ? [] : Object.entries(c).filter(([t]) => t !== "_other"),
  );
  const filters = tables.some(([, t]) => typeof t !== "string" && Object.values(t).includes("excluded"));
  if (filters)
    throw bad(
      "FieldFiltersUnsupported",
      "S3 exports can't filter fields within a table yet. Select whole tables instead.",
    );
}

/** A selection as Convex serializes it: each level's entries in byte order, then `_other`. */
function selectionJson(s: unknown): unknown {
  if (!isMap(s)) return s;
  const out: Record<string, unknown> = {};
  const names = Object.keys(s).filter((k) => k !== "_other");
  for (const k of names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) out[k] = selectionJson(s[k]);
  out._other = s._other;
  return out;
}

/** A string field (an `Option<String>` when `optional`, where `null` is none). */
function s3String(v: unknown, optional: boolean): string | null {
  if (v === null && optional) return null;
  if (typeof v !== "string") throw badBody(`invalid type: ${unexpected(v)}, expected a string`);
  return v;
}

type S3CreateArgs = {
  bucket: string;
  region: string;
  prefix?: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  selection?: Level | null;
  period: string;
};

/** `CreateS3ExportLogStreamArgs` as serde reads it: each field in the body's order, then the missing ones. */
function s3CreateArgs(b: Body): S3CreateArgs {
  const got: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === "bucket" || k === "region" || k === "accessKeyId" || k === "secretAccessKey") got[k] = s3String(v, false);
    else if (k === "prefix") got[k] = s3String(v, true);
    else if (k === "selection") got[k] = v === null ? null : selectionArg(v);
    else if (k === "period") got[k] = unitVariant(v, PERIODS);
  }
  for (const k of ["bucket", "region", "accessKeyId", "secretAccessKey", "period"])
    if (!(k in got)) throw badBody(`missing field \`${k}\``);
  return got as S3CreateArgs;
}

/** `UpdateS3ExportSinkArgs` (`deny_unknown_fields`): only the secret, the selection and the period can change. */
function s3UpdateArgs(b: Body): {
  secretAccessKey?: string | null;
  selection?: Level | null;
  period?: string | null;
} {
  const got: ReturnType<typeof s3UpdateArgs> = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === "logStreamType") continue;
    if (k === "secretAccessKey") got.secretAccessKey = s3String(v, true);
    else if (k === "selection") got.selection = v === null ? null : selectionArg(v);
    else if (k === "period") got.period = v === null ? null : unitVariant(v, PERIODS);
    else throw badBody(`unknown field \`${k}\`, expected one of \`secretAccessKey\`, \`selection\`, \`period\``);
  }
  return got;
}

function stringRecord(v: unknown): Record<string, string> | null | undefined {
  if (v === undefined || v === null) return v as undefined | null;
  if (typeof v !== "object" || Array.isArray(v) || !Object.values(v).every((x) => typeof x === "string"))
    throw badBody(`invalid type: ${unexpected(v)}, expected a map`);
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
        throw badBody(
          b.ddTags === undefined
            ? "missing field `ddTags`"
            : `invalid type: ${unexpected(b.ddTags)}, expected a sequence`,
        );
      const service = str(b, "service", true);
      const topics = topicsArg(b);
      checkTopics(topics);
      return clean({ type, siteLocation, ddApiKey, ddTags: b.ddTags, version: "2", service, topics });
    }
    case "axiom": {
      const apiKey = str(b, "apiKey");
      const datasetName = str(b, "datasetName");
      if (b.attributes === undefined) throw badBody("missing field `attributes`");
      const attributes = attributesArg(b.attributes);
      const ingestUrl = str(b, "ingestUrl", true);
      const topics = topicsArg(b);
      checkAttributes(attributes);
      checkIngestUrl(ingestUrl);
      checkTopics(topics);
      return clean({ type, apiKey, datasetName, attributes, version: "2", ingestUrl, topics });
    }
    case "sentry": {
      const dsn = str(b, "dsn");
      const tags = stringRecord(b.tags);
      checkDsn(dsn);
      return clean({ type, dsn, tags, version: "2" });
    }
    case "postHogLogs": {
      const apiKey = str(b, "apiKey");
      const host = str(b, "host", true);
      const serviceName = str(b, "serviceName", true);
      const topics = topicsArg(b);
      checkHost(host);
      checkTopics(topics);
      return clean({ type, apiKey, host, serviceName, topics });
    }
    case "postHogErrorTracking": {
      const apiKey = str(b, "apiKey");
      const host = str(b, "host", true);
      checkHost(host);
      return clean({ type, apiKey, host });
    }
    case "s3Export": {
      const a = s3CreateArgs(b);
      checkBucket(a.bucket);
      // Everything by default, stored as such.
      const selection = a.selection ?? { _other: "included" };
      checkWholeTables(selection);
      return {
        type,
        bucket: a.bucket,
        region: a.region,
        prefix: a.prefix ?? null,
        accessKeyId: a.accessKeyId,
        secretAccessKey: a.secretAccessKey,
        selection,
        period: a.period,
      };
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
      if (b.attributes !== undefined) set("attributes", checkAttributes(attributesArg(b.attributes)));
      set("ingestUrl", str(b, "ingestUrl", true));
      set("topics", topicsArg(b));
      checkIngestUrl(next.ingestUrl as string | undefined);
      checkTopics(next.topics as LogTopic[] | undefined);
      break;
    }
    case "sentry": {
      set("dsn", keep("dsn"));
      set("tags", stringRecord(b.tags));
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
      // The destination and the access key ID stay as created; a `null` keeps the field as it is.
      const a = s3UpdateArgs(b);
      if (a.selection) checkWholeTables(a.selection);
      if (a.secretAccessKey) next.secretAccessKey = a.secretAccessKey;
      if (a.selection) next.selection = a.selection;
      if (a.period) next.period = a.period;
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
        ...(c.prefix === undefined || c.prefix === null ? {} : { prefix: c.prefix }),
        accessKeyId: c.accessKeyId,
        selection: selectionJson(c.selection),
        period: c.period,
      };
    case "local":
      return null;
  }
}

/** The routes. `wake`: run the log manager's worker after a change (`LogManager.wakeAfterChange`). */
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
  /**
   * The body, as Convex's extractor reads `CreateLogStreamArgs` / `UpdateLogStreamArgs` (internally tagged by
   * `logStreamType`): its content type, its JSON and its tag, before the route's operation is checked. The
   * variant's own fields are checked after (`createConfig`, `updatedConfig`).
   */
  const body = async (name: string): Promise<Body> => {
    const text = await req.text();
    try {
      checkJsonBody(req, text, { name, fields: [], tagged: { tag: "logStreamType", variants: API_TYPES } });
    } catch (e) {
      if (e instanceof BadJsonBody) throw bad(e.code, e.message);
      throw e;
    }
    const b = JSON.parse(text) as unknown;
    // A sequence names its variant first (serde's tagged form); the route reads a map.
    return (Array.isArray(b) ? { logStreamType: b[0] } : b) as Body;
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
      const b = await body("CreateLogStreamArgs");
      // The variant's fields as serde reads them (its errors before the operation's check); Convex's own checks of
      // their values come after it.
      try {
        createConfig(b);
      } catch (e) {
        if (e instanceof LogSinkError && e.code === "BadJsonBody") throw e;
      }
      functions.requireOperation(caller, "WriteIntegrations");
      const type = b.logStreamType;
      // An S3 export copies the deployment's data out: it also needs ViewData (Convex 4933aa2).
      if (type === "s3Export") functions.requireOperation(caller, "ViewData");
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
      }, "_system/create_log_stream");
      deps.wake();
      return json(
        config.type === "webhook"
          ? { logStreamType: "webhook", id: newId, hmacSecret: config.hmacSecret }
          : { logStreamType: config.type, id: newId },
      );
    }
    case "update_log_stream": {
      if (req.method !== "POST") break;
      // Convex's extractors: the path's id and the body, then the operation.
      const sinkId = needId();
      const b = await body("UpdateLogStreamArgs");
      // An S3 export's fields are read with the body (serde's `deny_unknown_fields`), before the operation.
      if (b.logStreamType === "s3Export") s3UpdateArgs(b);
      functions.requireOperation(caller, "WriteIntegrations");
      await engine.mutation(async (db) => {
        const row = await mustGetSink(db, sinkId);
        if (row.config.type === "s3Export") functions.requireOperation(caller, "ViewData");
        const config = updatedConfig(row.config, b);
        await patchSink(db, row._id, { config });
        await audit(db, auditEvents.updateIntegration(sinkId, row.config.type));
        // Verified again (Convex's `reset_log_sink_to_pending`).
        await patchSink(db, row._id, { status: { type: "pending" } });
      }, "_system/update_log_stream");
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
      }, "_system/delete_log_stream");
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
      }, "_system/rotate_webhook_secret");
      // As Convex's, the running sink keeps signing with the old secret until it restarts.
      return json({ logStreamType: "webhook", hmacSecret: secret });
    }
  }
  return Response.json({ code: "NotFound", message: `no route for /api/v1/${route}` }, { status: 404 });
}

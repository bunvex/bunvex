// The deployment's OpenAPI documents (STUDY-115), as Convex's (`crates/local_backend/src/router.rs`): the
// platform API at `GET /api/v1/openapi.json`, the dashboard routes at `/api/dashboard_openapi.json` and the
// function API at `/api/public_openapi.json`, each OpenAPI 3.1 as pretty JSON, with no auth.
//
// They list the routes bunvex has, with Convex's paths, operation ids and request and response schemas
// (openapi-schemas.ts); OPENAPI_LEFT_OUT lists Convex's others and why (DV-381). Titles, descriptions and the
// security scheme are bunvex's (DV-382). The table below is also what the router answers under `/api/v1/`
// (`isPlatformPath`), and openapi.test.ts checks every documented route against the server, so the documents
// cannot drift from it.
import { DASHBOARD_SCHEMAS, type JsonSchema, PLATFORM_SCHEMAS, PUBLIC_SCHEMAS } from "./openapi-schemas.ts";

export type OpenApiDocName = "platform" | "dashboard" | "public";
type Method = "get" | "post";

type Param = { name: string; in: "query" | "path"; description: string; required: boolean; schema: JsonSchema };

/** One documented route; `path` is relative to its document's server (`/api/v1` or `/api`). */
export type ApiOperation = {
  doc: OpenApiDocName;
  method: Method;
  path: string;
  operationId: string;
  summary: string;
  description: string;
  tags?: string[];
  params?: Param[];
  /** The request body's schema name (always required, as Convex's `Json` extractor). */
  body?: string;
  /** The 200 answer's JSON schema; none for an empty answer. */
  response?: JsonSchema;
};

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const STRING: JsonSchema = { type: "string" };
const pathId = (what: string): Param => ({ name: "id", in: "path", description: what, required: true, schema: STRING });

/** Where each document is served, and the prefix its paths are relative to. */
export const OPENAPI_DOCS: Record<OpenApiDocName, { url: string; prefix: string }> = {
  platform: { url: "/api/v1/openapi.json", prefix: "/api/v1" },
  dashboard: { url: "/api/dashboard_openapi.json", prefix: "/api" },
  public: { url: "/api/public_openapi.json", prefix: "/api" },
};

/** Every documented route, in Convex's order within each document. */
export const OPENAPI_OPERATIONS: readonly ApiOperation[] = [
  // ---------------------------------------------------------------- platform (`/api/v1`)
  {
    doc: "platform",
    method: "post",
    path: "/update_environment_variables",
    tags: ["Environment Variables"],
    operationId: "update_environment_variables",
    summary: "Update environment variables",
    description:
      "Set or delete environment variables, all in one change. Every subscription is invalidated, since functions read them.",
    body: "UpdateEnvVarsRequest",
  },
  {
    doc: "platform",
    method: "get",
    path: "/list_environment_variables",
    tags: ["Environment Variables"],
    operationId: "list_environment_variables",
    summary: "List environment variables",
    description: "Every environment variable of the deployment, with its value.",
    response: ref("ListEnvVarsResponse"),
  },
  {
    doc: "platform",
    method: "get",
    path: "/list_audit_log_events",
    tags: ["Audit Log"],
    operationId: "list_audit_log_events",
    summary: "List audit log events",
    description:
      "The deployment's audit log from a time on, the oldest event first, a page at a time: pass `pagination.nextCursor` back as `cursor`, with the same `from`.",
    params: [
      {
        name: "from",
        in: "query",
        description: "The first time to include, in milliseconds since the epoch; the same on every page.",
        required: true,
        schema: { type: "integer", format: "int64", minimum: 0 },
      },
      {
        name: "limit",
        in: "query",
        description: "How many events a page has at most: 15 by default, 100 at most.",
        required: false,
        schema: { type: ["integer", "null"], minimum: 0 },
      },
      {
        name: "cursor",
        in: "query",
        description: "The previous page's `nextCursor`.",
        required: false,
        schema: { type: ["string", "null"] },
      },
    ],
    response: ref("ListDeploymentAuditLogEventsResponse"),
  },
  {
    doc: "platform",
    method: "get",
    path: "/get_current_usage",
    tags: ["Usage Limits", "beta"],
    operationId: "get_current_usage",
    summary: "Get current usage",
    description:
      "Each usage limit metric's usage in the current UTC day and month. Only a `complete` `seedStatus` means the windows include what came before the server started.",
    response: ref("GetCurrentUsageResponse"),
  },
  {
    doc: "platform",
    method: "get",
    path: "/list_usage_limits",
    tags: ["Usage Limits"],
    operationId: "list_usage_limits",
    summary: "List usage limits",
    description: "Every usage limit set on the deployment.",
    response: ref("ListUsageLimitsResponse"),
  },
  {
    doc: "platform",
    method: "post",
    path: "/create_usage_limit",
    tags: ["Usage Limits"],
    operationId: "create_usage_limit",
    summary: "Create usage limit",
    description: "Add a usage limit. A metric has at most one limit per window and limit type.",
    body: "UsageLimitConfigRequest",
    response: ref("UsageLimitResponse"),
  },
  {
    doc: "platform",
    method: "post",
    path: "/update_usage_limit/{id}",
    tags: ["Usage Limits"],
    operationId: "update_usage_limit",
    summary: "Update usage limit",
    description: "Replace a usage limit's configuration.",
    params: [pathId("The usage limit's id.")],
    body: "UsageLimitConfigRequest",
    response: ref("UsageLimitResponse"),
  },
  {
    doc: "platform",
    method: "post",
    path: "/delete_usage_limit/{id}",
    tags: ["Usage Limits"],
    operationId: "delete_usage_limit",
    summary: "Delete usage limit",
    description: "Remove a usage limit.",
    params: [pathId("The usage limit's id.")],
  },
  {
    doc: "platform",
    method: "post",
    path: "/update_canonical_url",
    tags: ["Canonical URLs"],
    operationId: "update_canonical_url",
    summary: "Update canonical URL",
    description:
      "Set the public URL of the deployment's API or of its HTTP actions, which functions read as `BUNVEX_CLOUD_URL` and `BUNVEX_SITE_URL`; without `url`, go back to the server's own.",
    body: "UpdateCanonicalUrlRequest",
  },
  {
    doc: "platform",
    method: "get",
    path: "/get_canonical_urls",
    tags: ["Canonical URLs"],
    operationId: "get_canonical_urls",
    summary: "Get canonical URLs",
    description: "The public URLs of the deployment's API and HTTP actions.",
    response: ref("GetCanonicalUrlsResponse"),
  },
  {
    doc: "platform",
    method: "get",
    path: "/list_log_streams",
    tags: ["Log Streams"],
    operationId: "list_log_streams",
    summary: "List log streams",
    description: "Every log stream of the deployment, with its configuration and status.",
    response: { type: "array", items: ref("LogStreamConfig") },
  },
  {
    doc: "platform",
    method: "get",
    path: "/get_log_stream/{id}",
    tags: ["Log Streams"],
    operationId: "get_log_stream",
    summary: "Get log stream",
    description: "One log stream, by id.",
    params: [pathId("The log stream's id.")],
    response: ref("LogStreamConfig"),
  },
  {
    doc: "platform",
    method: "post",
    path: "/delete_log_stream/{id}",
    tags: ["Log Streams"],
    operationId: "delete_log_stream",
    summary: "Delete log stream",
    description: "Remove a log stream.",
    params: [pathId("The log stream's id.")],
  },
  {
    doc: "platform",
    method: "post",
    path: "/create_log_stream",
    tags: ["Log Streams"],
    operationId: "create_log_stream",
    summary: "Create log stream",
    description: "Add a log stream. A deployment has at most one of each type.",
    body: "CreateLogStreamArgs",
    response: ref("CreateLogStreamResponse"),
  },
  {
    doc: "platform",
    method: "post",
    path: "/update_log_stream/{id}",
    tags: ["Log Streams"],
    operationId: "update_log_stream",
    summary: "Update log stream",
    description: "Change a log stream: a field left out keeps its value, and `null` clears it.",
    params: [pathId("The log stream's id.")],
    body: "UpdateLogStreamArgs",
  },
  {
    doc: "platform",
    method: "post",
    path: "/rotate_webhook_secret/{id}",
    tags: ["Log Streams"],
    operationId: "rotate_webhook_secret",
    summary: "Rotate webhook log stream secret",
    description: "Give a webhook log stream a new signing secret.",
    params: [pathId("The webhook log stream's id.")],
    response: ref("RotateLogStreamSecretResponse"),
  },
  {
    doc: "platform",
    method: "post",
    path: "/pause_deployment",
    tags: ["Pause/Unpause"],
    operationId: "pause_deployment",
    summary: "Pause deployment",
    description:
      "Stop the deployment, keeping its data: function calls fail, scheduled functions wait, and cron jobs are skipped until it is unpaused.",
  },
  {
    doc: "platform",
    method: "post",
    path: "/unpause_deployment",
    tags: ["Pause/Unpause"],
    operationId: "unpause_deployment",
    summary: "Unpause deployment",
    description: "Start a paused deployment again; the scheduled functions that waited run.",
  },
  {
    doc: "platform",
    method: "post",
    path: "/data/sync",
    tags: ["Data Sync", "pro"],
    operationId: "data_sync",
    summary: "Data sync",
    description:
      "Export the deployment's data, or part of it, a page at a time, then its changes. Pass each page's `pagination.nextCursor` back as `cursor`; the first call has none. A one-time export stops at the first `upToDate` page; a continuous one keeps asking, best with a pause after an `upToDate` page. Needs the ViewData operation.",
    body: "DataSyncArgs",
    response: ref("DataSyncResponse"),
  },
  {
    doc: "platform",
    method: "get",
    path: "/data/list_active_syncs",
    tags: ["Data Sync", "pro"],
    operationId: "list_active_syncs",
    summary: "List active data syncs",
    description: "The data syncs that fetched a page in the last 3 days, with their progress.",
    params: [
      {
        name: "limit",
        in: "query",
        description: "How many syncs a page has at most: 50 by default, 100 at most.",
        required: false,
        schema: { type: ["integer", "null"], minimum: 0 },
      },
      {
        name: "cursor",
        in: "query",
        description: "The previous page's `nextCursor`.",
        required: false,
        schema: { type: ["string", "null"] },
      },
    ],
    response: ref("ListActiveSyncsResponse"),
  },
  {
    doc: "platform",
    method: "get",
    path: "/data/sync/{sync_id}",
    tags: ["Data Sync", "pro"],
    operationId: "get_active_sync",
    summary: "Get an active data sync",
    description:
      "One data sync's progress, by the `syncId` its pages carry; 404 once it has not fetched a page for 3 days. Needs the ViewData operation.",
    params: [
      {
        name: "sync_id",
        in: "path",
        description: "The sync's `syncId`.",
        required: true,
        schema: ref("SyncId"),
      },
    ],
    response: ref("ActiveDataSync"),
  },
  // ---------------------------------------------------------------- dashboard (`/api`)
  {
    doc: "dashboard",
    method: "get",
    path: "/check_admin_key",
    tags: ["public_api"],
    operationId: "check_admin_key",
    summary: "Check admin key validity",
    description:
      "Whether the request's admin key belongs to this deployment, with the operations it allows and whether it is read-only.",
    response: {},
  },
  {
    doc: "dashboard",
    method: "get",
    path: "/shapes2",
    operationId: "shapes2",
    summary: "Get table shapes",
    description: "The shape inferred from each table's documents.",
    params: [
      {
        name: "component",
        in: "query",
        description: "The component's id; bunvex has only the root component.",
        required: false,
        schema: STRING,
      },
    ],
    response: {},
  },
  {
    doc: "dashboard",
    method: "post",
    path: "/delete_tables",
    operationId: "delete_tables",
    summary: "Delete database tables",
    description: "Delete tables with their documents and indexes.",
    body: "DeleteTableArgs",
  },
  {
    doc: "dashboard",
    method: "post",
    path: "/delete_scheduled_functions_table",
    operationId: "delete_scheduled_functions_table",
    summary: "Delete all scheduled functions",
    description: "Replace the scheduled functions' table with an empty one, in one transaction, whatever it holds.",
    body: "DeleteScheduledFunctionsTableRequest",
  },
  // ---------------------------------------------------------------- public (`/api`)
  {
    doc: "public",
    method: "get",
    path: "/query",
    operationId: "public_query_get",
    summary: "Execute query (GET)",
    description: "Run a query, its path and arguments in the URL.",
    params: [
      { name: "path", in: "query", description: "The function's path.", required: true, schema: STRING },
      { name: "args", in: "query", description: "The arguments, as JSON text.", required: true, schema: STRING },
      {
        name: "format",
        in: "query",
        description: "How the answer's values are written.",
        required: false,
        schema: STRING,
      },
    ],
    response: ref("UdfResponse"),
  },
  {
    doc: "public",
    method: "post",
    path: "/query",
    operationId: "public_query_post",
    summary: "Execute query (POST)",
    description: "Run a query.",
    body: "UdfPostRequest",
    response: ref("UdfResponse"),
  },
  {
    doc: "public",
    method: "post",
    path: "/query_ts",
    operationId: "public_get_query_ts",
    summary: "Get latest timestamp",
    description: "The latest timestamp, for a series of `/query_at_ts` calls that read one snapshot.",
    response: ref("Ts"),
  },
  {
    doc: "public",
    method: "post",
    path: "/query_at_ts",
    operationId: "public_query_at_ts_post",
    summary: "Execute query at timestamp",
    description: "Run a query at a timestamp `/query_ts` gave.",
    body: "UdfPostWithTsRequest",
    response: ref("UdfResponse"),
  },
  {
    doc: "public",
    method: "post",
    path: "/query_batch",
    operationId: "public_query_batch_post",
    summary: "Execute query batch",
    description: "Run several queries at one timestamp, each answered in order.",
    body: "QueryBatchArgs",
    response: ref("QueryBatchResponse"),
  },
  {
    doc: "public",
    method: "post",
    path: "/mutation",
    operationId: "public_mutation_post",
    summary: "Execute mutation",
    description: "Run a mutation.",
    body: "UdfPostRequest",
    response: ref("UdfResponse"),
  },
  {
    doc: "public",
    method: "post",
    path: "/action",
    operationId: "public_action_post",
    summary: "Execute action",
    description: "Run an action.",
    body: "UdfPostRequest",
    response: ref("UdfResponse"),
  },
  {
    doc: "public",
    method: "post",
    path: "/function",
    operationId: "public_function_post",
    summary: "Execute any function",
    description: "Run a query, mutation or action by its path, whatever its kind. Needs an admin key.",
    body: "UdfPostRequestWithComponent",
    response: ref("UdfResponse"),
  },
  {
    doc: "public",
    method: "post",
    path: "/run/{*functionIdentifier}",
    operationId: "public_function_post_with_path",
    summary: "Execute function by URL path",
    description: "Run a query, mutation or action named by the URL: `/run/messages/list` is `messages:list`.",
    params: [
      {
        name: "functionIdentifier",
        in: "path",
        description: "The function's module path and name, e.g. `messages/list`.",
        required: true,
        schema: STRING,
      },
    ],
    body: "UdfPostRequestArgsOnly",
    response: ref("UdfResponse"),
  },
];

/**
 * Convex's documented routes that bunvex does not answer, and why (DV-381): each is left out of the
 * documents, and the server answers it 404 (openapi.test.ts checks both).
 */
export const OPENAPI_LEFT_OUT: readonly {
  doc: OpenApiDocName;
  method: Method;
  path: string;
  reason: "not built yet" | "n/a";
  note: string;
}[] = [
  {
    doc: "platform",
    method: "get",
    path: "/deployment_info",
    reason: "not built yet",
    note: 'A self-hosted deployment answers `{kind: "selfHosted"}`; a cloud one, its team and project ids.',
  },
  {
    doc: "dashboard",
    method: "get",
    path: "/get_indexes",
    reason: "not built yet",
    note: "The dashboard reads indexes through system queries instead.",
  },
  {
    doc: "dashboard",
    method: "post",
    path: "/delete_component",
    reason: "not built yet",
    note: "bunvex has no components yet (STUDY-62).",
  },
];

const INFO: Record<OpenApiDocName, { title: string; description: string }> = {
  platform: {
    title: "bunvex Deployment API",
    description:
      "The admin API of a bunvex deployment: environment variables, the audit log, usage limits, canonical URLs, log streams, pausing and data sync.",
  },
  dashboard: {
    title: "bunvex Dashboard HTTP routes",
    description: "Routes the dashboard calls. Each needs an admin key.",
  },
  public: {
    title: "bunvex Public HTTP routes",
    description:
      "Run the deployment's functions over HTTP. A request may carry a user's token (`Bearer <token>`) or an admin key (`Bunvex <key>`), as the function needs.",
  },
};

const SERVERS: Record<OpenApiDocName, JsonSchema[]> = {
  platform: [
    {
      url: "{deployment-url}/api/v1",
      description: "Your bunvex deployment",
      variables: {
        "deployment-url": { default: "http://127.0.0.1:3210", description: "The deployment's URL" },
      },
    },
  ],
  dashboard: [{ url: "/api", description: "The deployment's API" }],
  public: [{ url: "/api", description: "The deployment's API" }],
};

const SCHEMAS: Record<OpenApiDocName, Record<string, JsonSchema>> = {
  platform: PLATFORM_SCHEMAS,
  dashboard: DASHBOARD_SCHEMAS,
  public: PUBLIC_SCHEMAS,
};

/** The platform API's one way in: an admin key in `Authorization` (DV-97), never a user's token. */
const ADMIN_KEY = "Admin Key";
const SECURITY_SCHEMES = {
  [ADMIN_KEY]: {
    type: "apiKey",
    in: "header",
    name: "Authorization",
    description:
      "The deployment's admin key, after the `Bunvex ` prefix: `Authorization: Bunvex <admin_key>`. `bunvex admin-key` prints one. A user's `Bearer` token is not accepted here.",
  },
};

function operationJson(op: ApiOperation): JsonSchema {
  return {
    ...(op.tags ? { tags: op.tags } : {}),
    summary: op.summary,
    description: op.description,
    operationId: op.operationId,
    ...(op.params ? { parameters: op.params } : {}),
    ...(op.body ? { requestBody: { content: { "application/json": { schema: ref(op.body) } }, required: true } } : {}),
    responses: {
      "200": {
        description: "",
        ...(op.response ? { content: { "application/json": { schema: op.response } } } : {}),
      },
    },
    ...(op.doc === "platform" ? { security: [{ [ADMIN_KEY]: [] }] } : {}),
  };
}

/** A document, as an object: the keys in utoipa's order (`openapi`, `info`, `servers`, `paths`, `components`). */
export function openApiDocument(doc: OpenApiDocName): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const op of OPENAPI_OPERATIONS) {
    if (op.doc !== doc) continue;
    paths[op.path] ??= {};
    paths[op.path]![op.method] = operationJson(op);
  }
  return {
    openapi: "3.1.0",
    info: {
      ...INFO[doc],
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
      version: "1.0.0",
    },
    servers: SERVERS[doc],
    paths,
    components: {
      schemas: SCHEMAS[doc],
      ...(doc === "platform" ? { securitySchemes: SECURITY_SCHEMES } : {}),
    },
  };
}

const texts = new Map<OpenApiDocName, string>();
/** A document's text: pretty JSON, two spaces, as serde_json's `to_string_pretty`. Built once. */
export function openApiText(doc: OpenApiDocName): string {
  let text = texts.get(doc);
  if (text === undefined) {
    text = JSON.stringify(openApiDocument(doc), null, 2);
    texts.set(doc, text);
  }
  return text;
}

const DOC_AT = new Map(Object.entries(OPENAPI_DOCS).map(([name, d]) => [d.url, name as OpenApiDocName]));
/** The document a path serves, if any (one lookup: this runs on every request). */
export const openApiDocAt = (pathname: string): OpenApiDocName | null => DOC_AT.get(pathname) ?? null;

/**
 * The answer to a document's URL: GET (and HEAD) get the text as `text/plain; charset=utf-8`, which is what
 * axum gives the `String` Convex returns; another method is 405, as an axum `get` route.
 */
export function openApiResponse(doc: OpenApiDocName, req: Request): Response {
  if (req.method !== "GET" && req.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET,HEAD" } });
  return new Response(req.method === "HEAD" ? null : openApiText(doc), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** A template (`/data/sync/{sync_id}`, `/run/{*rest}`) as a regex over the full path. */
const templateRegex = (prefix: string, path: string) =>
  new RegExp(
    `^${(prefix + path)
      .split(/(\{\*?[^}]+\})/)
      .map((part) =>
        part.startsWith("{*") ? ".+" : part.startsWith("{") ? "[^/]+" : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"),
      )
      .join("")}$`,
  );

const PLATFORM_PATHS = OPENAPI_OPERATIONS.filter((op) => op.doc === "platform").map((op) =>
  templateRegex(OPENAPI_DOCS.platform.prefix, op.path),
);

/**
 * Whether a path under `/api/v1/` is a platform route (any method; the route answers a wrong one): the router
 * answers every other `/api/v1/` path 404, so a route cannot be served there without being documented.
 */
export const isPlatformPath = (pathname: string) =>
  pathname === OPENAPI_DOCS.platform.url || PLATFORM_PATHS.some((r) => r.test(pathname));

/** @internal For tests: a documented path's full URL path, its parameters filled with `value`. */
export const concretePath = (doc: OpenApiDocName, path: string, value = "x") =>
  OPENAPI_DOCS[doc].prefix + path.replace(/\{\*?[^}]+\}/g, value);

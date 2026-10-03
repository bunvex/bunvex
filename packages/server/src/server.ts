// The transports: the HTTP one-shot API (Convex's `/api/{query,mutation,action}` shape) and the sync
// protocol v1 at `/api/{version}/sync` (sync.ts, STUDY-23). One process: the committer is single by design.
import { type AuthConfig, AuthenticationError, parseAuthConfig, TokenVerifier } from "@bunvex/auth";
import {
  type Caller,
  type Engine,
  EnvironmentVariableError,
  type EnvVarChange,
  OccError,
  parseValue,
  stringifyValue,
} from "@bunvex/core";
import { type BlobStore, blobStoreFromEnv } from "@bunvex/file-storage";
import { v1 } from "@bunvex/protocol";
import { decodeId } from "@bunvex/values";
import type { Server } from "bun";
import { TooManyConcurrentRequestsError } from "./action-permits.ts";
import {
  ADMIN_KEY_PURPOSE,
  AdminKeys,
  actingIdentity,
  BadAdminKeyError,
  BadDeployKeyError,
  HeaderParseError,
  OperationNotPermittedError,
  removeTypePrefix,
  splitActingAs,
} from "./admin-keys.ts";
import { loadLatestCode, type SourcePackage, udfConfig, writeCodeRows, writePackage } from "./code-store.ts";
import { CodeVersion, type ModuleSource } from "./code-version.ts";
import { type Crons, cronSpecs } from "./cron.ts";
import { CronJobExecutor } from "./cron-executor.ts";
import {
  clientError,
  FunctionPathError,
  INTERNAL_SERVER_ERROR_MESSAGE,
  isSystemError,
  isTryAgainError,
  withRequestId,
} from "./errors.ts";
import { ExportError, ExportService } from "./exports.ts";
import { type AdminCaller, adminCallerOf, callerOf, type Functions } from "./functions.ts";
import { httpActionServer } from "./http-actions.ts";
import type { ImportFormat } from "./import-parse.ts";
import { ImportError, type ImportOptions, ImportRequestError, ImportService, MODE_ARGS } from "./imports.ts";
import { collectLogs, type WithLogLines } from "./logs.ts";
import { evaluateAuthConfig, PushError, PushService } from "./push.ts";
import { checkRouter, type HttpRouter } from "./router.ts";
import { ScheduledJobExecutor, type SchedulerOptions, schedulerOptionsFromEnv } from "./scheduler.ts";
import { sessionRetentionFromEnv, startSessionCleanup } from "./session-cleanup.ts";
import { FileStorage, StorageError, startFileSweeps } from "./storage.ts";
import {
  fromWireTs,
  MAX_PENDING_MUTATIONS,
  type SplayOptions,
  SyncHub,
  SyncSession,
  splayOptions,
  wireTs,
} from "./sync.ts";
import { cancelAllScheduledJobs, cancelScheduledJob } from "./system-functions.ts";

export { MAX_PENDING_MUTATIONS };

/** A socket's state: its sync session. */
type WsData = { session: SyncSession };

export type ServerOptions = {
  engine: Engine;
  functions: Functions;
  port?: number;
  /** The interface both ports listen on (Convex's `--interface`; default Bun's, all interfaces). */
  hostname?: string;
  label?: string;
  /** What to do when persistence fails and the committer stops. Default: log and exit(1), as Convex does, so
   *  a supervisor restarts the process and it recovers from what persistence durably holds. */
  onFatal?: (e: Error) => void;
  /**
   * Hide error details and log lines from clients (Convex's `--redact-logs-to-client`, for production): a
   * failing function then answers only `[Request ID: …] Server Error`, and no `logLines`. A `BunvexError`'s
   * data is still sent. Default: the `REDACT_LOGS_TO_CLIENT` environment variable, else off — Convex's
   * self-hosted default, which suits development.
   */
  redactLogsToClient?: boolean;
  /**
   * How long the sync protocol keeps a committed mutation's record for idempotent resends
   * (`_session_requests`, STUDY-23 P6); null keeps them forever. Default: `MAX_SESSION_CLEANUP_DURATION_HOURS`,
   * else two weeks, as Convex.
   */
  sessionRequestRetentionMs?: number | null;
  /**
   * The auth config (STUDY-27): the default export of the app's `bunvex/auth.config.ts`, as Convex's
   * `convex/auth.config.ts`. Validated at start (an invalid one throws here). Without it, any token is
   * refused with "no providers configured", as in Convex.
   */
  auth?: AuthConfig;
  /** `fetch` for OIDC discovery and JWKS (tests point it at an in-process issuer). */
  authFetch?: typeof fetch;
  /**
   * Scheduled functions (STUDY-30): the executor's knobs. Default: Convex's, overridden by
   * `SCHEDULED_JOB_EXECUTION_PARALLELISM` / `SCHEDULED_JOB_RETENTION`.
   */
  scheduler?: SchedulerOptions;
  /**
   * The deployment's cron jobs (STUDY-30 S1): the default export of the app's `crons.ts`, as Convex's
   * `convex/crons.ts`. Checked at start (an invalid one throws here) and diffed with the stored ones by name.
   * The splay is `CRON_SPLAY_SECONDS` (60; 0 turns it off), as Convex.
   */
  crons?: Crons;
  /**
   * The deployment's HTTP actions (STUDY-31 H1): the default export of the app's `http.ts`, as Convex's
   * `convex/http.ts`. Checked at start. Served under `/http/…` on this port and at every path of the site
   * port.
   */
  http?: HttpRouter;
  /**
   * The site port, where HTTP actions answer at every path (Convex's `--site-proxy-port`). Default: `port`
   * + 1 (3211 next to 3210); a random one when `port` is 0; null serves no site port.
   */
  sitePort?: number | null;
  /**
   * The largest request body accepted, in bytes (H3). Default: Bun's (128 MiB). File uploads are exempt, as
   * Convex's upload route has no limit (F4).
   */
  maxRequestBodySize?: number;
  /**
   * Where the bytes of stored files go (STUDY-32): a blob backend, or null for no file storage. Default: from
   * the environment as Convex's image chooses — S3 when `S3_STORAGE_FILES_BUCKET` is set, else `STORAGE_DIR`,
   * else `<DATA>/storage`.
   */
  /**
   * A deployable server (STUDY-35): its functions are the deployed code — the latest version in the store,
   * loaded on start (`codeReady`), replaced by every push. Default false: an embedded server, whose
   * functions are registered in process (DV-167).
   */
  deployable?: boolean;
  /** Where pushed code packages are kept (default: the `modules` use case of the blob store, STUDY-35). */
  moduleStorage?: BlobStore;
  /**
   * Where snapshot exports are kept (STUDY-42): default the `exports` use case of the environment's blob
   * store (`storage/exports`, or S3_STORAGE_EXPORTS_BUCKET); null turns exports off.
   */
  exportStorage?: BlobStore | null;
  /**
   * Where snapshot import uploads are kept (STUDY-42): default the `snapshot_imports` use case of the
   * environment's blob store (`storage/snapshot_imports`, or S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET); null turns
   * imports off.
   */
  importStorage?: BlobStore | null;
  /** The import worker's clock and retry backoff (tests). */
  importOptions?: ImportOptions;
  fileStorage?: BlobStore | null;
  /**
   * The public origins (F2): the API's, which file URLs start with (Convex's `CONVEX_CLOUD_ORIGIN`), and the
   * site's, where HTTP actions answer (`CONVEX_SITE_ORIGIN`). Defaults: `BUNVEX_CLOUD_ORIGIN` /
   * `BUNVEX_SITE_ORIGIN`, else `http://127.0.0.1:<port>`.
   */
  cloudOrigin?: string;
  siteOrigin?: string;
  /** No response head from an HTTP action by then answers 408 (Convex: 300 s). For tests. */
  httpActionHeadTimeoutMs?: number;
  /**
   * Splaying of wide invalidations (STUDY-08 §3.5). Defaults: Convex's knobs from the environment
   * (`SUBSCRIPTION_INVALIDATION_DELAY_THRESHOLD`, `SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER`), else
   * Convex's values (200 subscriptions, 5 ms). Tests inject `random` and `timers`.
   */
  subscriptionSplay?: Partial<SplayOptions>;
};

/**
 * Arguments arrive in Convex's JSON form ($integer, $float, $bytes); functions receive Convex values. As in
 * Convex (`UdfArgsJson`), `args` is the arguments object or an array holding it (what Convex's clients send).
 */
const fromWire = (args: unknown) => parseValue(JSON.stringify((Array.isArray(args) ? args[0] : args) ?? {}));

/** As Convex's self-hosted entry script (`[ -n "$REDACT_LOGS_TO_CLIENT" ]`): any non-empty value turns it on. */
const envFlag = (v: string | undefined) => v !== undefined && v !== "";

/** `,"<field>":[…]` for the log lines a client may see, or nothing (Convex omits empty `logLines`). */
const linesField = (field: string, lines: string[], redact: boolean) =>
  redact || lines.length === 0 ? "" : `,${JSON.stringify(field)}:${JSON.stringify(lines)}`;

export function createServer(opts: ServerOptions) {
  const { engine, functions } = opts;
  const redact = opts.redactLogsToClient ?? envFlag(process.env.REDACT_LOGS_TO_CLIENT);
  const makeVerifier = (auth: AuthConfig | undefined) =>
    new TokenVerifier(auth === undefined ? [] : parseAuthConfig(auth), {
      redactErrors: redact,
      ...(opts.authFetch ? { fetch: opts.authFetch } : {}),
    });
  /** The auth config's verifier; a push replaces it with its auth.config's (STUDY-35). */
  let verifier = makeVerifier(opts.auth);
  /** This deployment's admin keys (STUDY-34): checked against its instance name and secret. */
  const adminKeys = new AdminKeys(engine.instanceName, engine.derivedKey(ADMIN_KEY_PURPOSE));
  /**
   * An admin key's caller (Convex's `authenticate` for `AuthenticationToken::Admin`): the key's identity,
   * acting as the user after its `:` when there is one (not with a system key).
   */
  const adminCaller = (raw: string, withActingAs: boolean): AdminCaller => {
    const { key, actingAs } = withActingAs ? splitActingAs(raw) : { key: removeTypePrefix(raw), actingAs: null };
    const admin = adminKeys.check(key);
    if (actingAs && admin.kind === "system")
      throw new Error("Admin identity returned from check_admin_key was not an admin.");
    return adminCallerOf(admin, actingAs);
  };
  /** An access failure as Convex answers it: its status and code, or the internal error. */
  const accessError = (e: unknown): Response | null => {
    if (
      e instanceof BadAdminKeyError ||
      e instanceof BadDeployKeyError ||
      e instanceof OperationNotPermittedError ||
      e instanceof HeaderParseError
    )
      return requestError(e.status, e.code, e.message);
    return null;
  };
  /**
   * The caller of an HTTP request, from its `Authorization` header (Convex's `ExtractAuthenticationToken`):
   * `Bunvex <admin key>[:<base64 identity>]` is an admin (DV-97), `Bearer <jwt>` a user verified against the
   * auth config; without a header, `?adminKey=` is an admin; otherwise no identity. A failure is the
   * request's error response.
   */
  const callerOfRequest = async (req: Request): Promise<Caller | Response> => {
    const header = req.headers.get("authorization");
    try {
      if (header === null) {
        const key = new URL(req.url).searchParams.get("adminKey");
        return key === null ? callerOf(null) : adminCaller(key, false);
      }
      if (header.length < 7) return requestError(400, "InvalidHeaderFailure", "Invalid authentication header");
      const scheme = header.slice(0, 7).toLowerCase();
      if (scheme === "bunvex ") return adminCaller(header.slice(7), true);
      if (scheme !== "bearer " || header.length === 7) return requestError(400, "InvalidAdminKey", "Invalid admin key");
      return callerOf((await verifier.verify(header.slice(7).trim())).identity);
    } catch (e) {
      if (e instanceof AuthenticationError) return requestError(e.status, e.code, e.message);
      const r = accessError(e);
      if (r) return r;
      if (e instanceof Error && e.message.startsWith("Admin identity returned"))
        return requestError(500, "InternalServerError", INTERNAL_SERVER_ERROR_MESSAGE);
      throw e;
    }
  };
  /**
   * An HTTP action's caller (STUDY-31): the same identification, but a failure never rejects the request —
   * it is kept, and `ctx.auth.getUserIdentity()` throws it (Convex's `Identity::Unknown(error)`).
   */
  const identifyHttpAction = async (req: Request): Promise<{ caller: Caller; error: Error | null }> => {
    const header = req.headers.get("authorization");
    const none = callerOf(null);
    try {
      if (header === null) {
        const key = new URL(req.url).searchParams.get("adminKey");
        return { caller: key === null ? none : adminCaller(key, false), error: null };
      }
      if (header.length < 7) return { caller: none, error: new Error("Invalid authentication header") };
      const scheme = header.slice(0, 7).toLowerCase();
      if (scheme === "bunvex ") return { caller: adminCaller(header.slice(7), true), error: null };
      if (scheme !== "bearer " || header.length === 7) return { caller: none, error: new Error("Invalid admin key") };
      return { caller: callerOf((await verifier.verify(header.slice(7).trim())).identity), error: null };
    } catch (e) {
      if (e instanceof AuthenticationError || accessError(e) || e instanceof Error)
        return { caller: none, error: new Error((e as Error).message) };
      throw e;
    }
  };
  const router = opts.http === undefined ? undefined : checkRouter(opts.http);
  /** What HTTP actions are served from; a code version replaces its router (STUDY-35). */
  const httpOptions = {
    functions,
    router,
    identify: identifyHttpAction,
    redact,
    headTimeoutMs: opts.httpActionHeadTimeoutMs,
  };
  const serveHttpAction = httpActionServer(httpOptions);

  /** A failed function run, for a client: the message (without its request id) and the app's data. */
  const formatError = (e: unknown): { error: string; data?: string } => {
    if (isSystemError(e)) return { error: INTERNAL_SERVER_ERROR_MESSAGE };
    const c = clientError(e, redact);
    return c.data === undefined ? { error: c.message } : { error: c.message, data: JSON.stringify(c.data) };
  };
  engine.committer.onFatal(
    opts.onFatal ??
      ((e) => {
        console.error(`bunvex: ${e.message}; shutting down`, e.cause);
        process.exit(1);
      }),
  );
  let server: Server<WsData> | null = null;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const jsonText = (body: string, status = 200) =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
  /** A request-level failure (not the function's): Convex's `{code, message}` body. */
  const requestError = (status: number, code: string, message: string) => json({ code, message }, status);

  /**
   * The response to a function call, as Convex's `UdfResponse`: `{status:"success", value, logLines?}`, or
   * — still HTTP 200, as Convex's backend answers — `{status:"error", errorMessage, errorData?, logLines?}`.
   * A system failure is a 500 with the fixed internal message.
   */
  const udfResponse = (r: WithLogLines<string>, kind: string) => {
    // A mutation that exhausted its OCC retries is not the function's error in Convex: the request fails
    // with 503 and the OCC code (`ErrorCode::OCC` → SERVICE_UNAVAILABLE, crates/errors/src/lib.rs). Inside
    // an action, the same error is just an exception the action may catch.
    if (!r.ok && kind === "mutation" && r.error instanceof OccError)
      return requestError(503, r.error.code, r.error.message);
    // Too many actions at once: Convex's rate-limited answer (429), not the function's error.
    if (!r.ok && r.error instanceof TooManyConcurrentRequestsError)
      return requestError(429, r.error.code, r.error.message);
    // An access check (an admin's operation, a key where one is required) is the request's error (403).
    if (!r.ok) {
      const denied = accessError(r.error);
      if (denied) return denied;
    }
    if (r.ok) return jsonText(`{"status":"success","value":${r.value}${linesField("logLines", r.logLines, redact)}}`);
    if (isSystemError(r.error))
      return requestError(isTryAgainError(r.error) ? 503 : 500, "InternalServerError", INTERNAL_SERVER_ERROR_MESSAGE);
    const e = formatError(r.error);
    const data = e.data === undefined ? "" : `,"errorData":${e.data}`;
    return jsonText(
      `{"status":"error","errorMessage":${JSON.stringify(withRequestId(e.error))}${data}${linesField("logLines", r.logLines, redact)}}`,
    );
  };

  const sync = new SyncHub({
    engine,
    functions,
    redact,
    formatError,
    fromWire,
    splay: splayOptions(opts.subscriptionSplay),
    verifyToken: (token) => verifier.verify(token),
    adminCaller: (key, impersonating) => {
      const admin = adminKeys.check(removeTypePrefix(key));
      if (impersonating === undefined || impersonating === null) return adminCallerOf(admin, null);
      const actingAs = actingIdentity(impersonating);
      if (!actingAs) throw new HeaderParseError();
      if (admin.kind === "system") throw new Error("Admin identity returned from check_admin_key was not an admin.");
      return adminCallerOf(admin, actingAs);
    },
  });
  const scheduler = new ScheduledJobExecutor(engine, functions, { ...schedulerOptionsFromEnv(), ...opts.scheduler });
  scheduler.start();
  const specs = opts.crons ? cronSpecs(opts.crons, (id, name) => functions.cronTarget(id, name)) : new Map();
  const splay = process.env.CRON_SPLAY_SECONDS;
  const cronExecutor = new CronJobExecutor(engine, functions, specs, {
    ...(splay === undefined || splay === "" ? {} : { cronSplaySeconds: Number(splay) }),
  });
  /** Resolves once the crons are registered (the diff with what was stored). */
  const cronsReady = cronExecutor.start(!opts.deployable);
  const stopCleanup = startSessionCleanup(
    engine,
    opts.sessionRequestRetentionMs === undefined ? sessionRetentionFromEnv() : opts.sessionRequestRetentionMs,
  );

  // ---------------------------------------------------------------- request body caps (H3, F4)
  /** Bun's default `maxRequestBodySize`, the cap every route but uploads keeps. */
  const cap = opts.maxRequestBodySize ?? 128 * 1024 * 1024;
  const payloadTooLarge = () => new Response("Payload Too Large", { status: 413 });
  /** A declared body over the cap: 413, as Bun answers it. */
  const bodyCap = (req: Request) => {
    const n = Number(req.headers.get("content-length") ?? 0);
    return n > cap ? payloadTooLarge() : null;
  };
  /** The request with its body cut off past the cap (a body sent without a length). */
  const capped = (req: Request): Request => {
    if (!req.body) return req;
    let seen = 0;
    const body = req.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, c) {
          seen += chunk.byteLength;
          if (seen > cap) c.error(new Error("Request body too large"));
          else c.enqueue(chunk);
        },
      }),
    );
    return new Request(req, { body, duplex: "half" } as RequestInit);
  };

  // ---------------------------------------------------------------- file storage (STUDY-32)
  let files: FileStorage | null = null;
  const serveStorage = async (fs: FileStorage, req: Request, url: URL): Promise<Response> => {
    if (req.method === "OPTIONS") return fs.preflight(req);
    try {
      if (url.pathname === "/api/storage/upload" && req.method === "POST")
        return fs.cors(req, await fs.upload(req, url));
      if (req.method === "GET" || req.method === "HEAD")
        return fs.cors(req, await fs.download(req, decodeURIComponent(url.pathname.slice("/api/storage/".length))));
      return fs.cors(req, new Response(null, { status: 405 }));
    } catch (e) {
      if (e instanceof StorageError) return fs.cors(req, requestError(e.status, e.code, e.message));
      if (isSystemError(e))
        return fs.cors(req, requestError(500, "InternalServerError", INTERNAL_SERVER_ERROR_MESSAGE));
      throw e;
    }
  };

  /** The push routes (set below, once the code store exists). */
  let exportRoute: (url: URL, req: Request) => Promise<Response> = async () =>
    requestError(503, "NotReady", "the server is starting");
  let importRoute: (url: URL, req: Request) => Promise<Response> = async () =>
    requestError(503, "NotReady", "the server is starting");
  let pushRoute: (url: URL, req: Request) => Promise<Response> = async () =>
    requestError(503, "NotReady", "the server is starting");
  /** The environment-variable routes (STUDY-37), set once the server's origins are known. */
  let envRoute: (url: URL, req: Request, caller: Caller) => Promise<Response> = async () =>
    requestError(503, "NotReady", "the server is starting");
  /** The admin routes; the caller is already identified. */
  const adminRoute = async (url: URL, req: Request, caller: Caller): Promise<Response> => {
    const admin = (caller as AdminCaller).admin;
    // Convex's `check_admin_key`: an admin or acting user (not the system) gets its operations.
    if (url.pathname === "/api/check_admin_key") {
      if (!admin || admin.kind !== "admin") throw new BadDeployKeyError(engine.instanceName);
      return json({ success: true, allowedOps: admin.allowedOps, isReadOnly: admin.readOnly });
    }
    // `/stats` (bunvex's counters) needs ViewMetrics (DV-162).
    if (url.pathname === "/stats") {
      functions.requireOperation(caller, "ViewMetrics");
      const c = engine.committer;
      return json({
        ...engine.stats,
        storage: opts.label, // field name kept for the benchmark harness
        ts: c.visibleTs,
        groups: c.groups,
        conflicts: c.conflicts,
        syncSessions: sync.sessions.size,
        sync: sync.stats,
      });
    }
    if (/^\/api\/(v1\/)?(update|list)_environment_variables$/.test(url.pathname)) return envRoute(url, req, caller);
    if (req.method !== "POST") return requestError(404, "NotFound", `no route for ${url.pathname}`);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await new Response(capped(req).body).text()) ?? {};
    } catch (e) {
      return requestError(400, "BadJsonBody", `invalid JSON body: ${(e as Error).message}`);
    }
    functions.requireOperation(caller, "WriteData");
    // Convex's `/api/cancel_job {id, componentId?}` and `/api/cancel_all_jobs {udfPath?, startNextTs?,
    // endNextTs?, componentId?, componentPath?}` (scheduling.rs): 200 with no body.
    if (url.pathname === "/api/cancel_job") {
      if (typeof body.id !== "string") return requestError(400, "BadJsonBody", "missing field `id`");
      await cancelScheduledJob(engine, body.id);
      return new Response(null, { status: 200 });
    }
    if (url.pathname === "/api/cancel_all_jobs") {
      const ns = (x: unknown) => (typeof x === "number" ? BigInt(Math.trunc(x)) : undefined);
      await cancelAllScheduledJobs(engine, {
        ...(typeof body.udfPath === "string" ? { udfPath: body.udfPath } : {}),
        ...(ns(body.startNextTs) === undefined ? {} : { startNextTs: ns(body.startNextTs) }),
        ...(ns(body.endNextTs) === undefined ? {} : { endNextTs: ns(body.endNextTs) }),
      });
      return new Response(null, { status: 200 });
    }
    return requestError(404, "NotFound", `no route for ${url.pathname}`);
  };

  server = Bun.serve<WsData, never>({
    port: opts.port ?? 3210,
    ...(opts.hostname ? { hostname: opts.hostname } : {}),
    idleTimeout: 120,
    // Uploads have no limit (F4): the API server takes any body, and every other route checks its own cap.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    websocket: {
      maxPayloadLength: 8 * 1024 * 1024,
      idleTimeout: 960,
      open(ws) {
        ws.data.session.open(ws);
      },
      message(ws, raw) {
        ws.data.session.message(String(raw));
      },
      close(ws) {
        ws.data.session.close();
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (/^\/api\/[^/]+\/sync$/.test(url.pathname)) {
        const data: WsData = { session: new SyncSession(sync) };
        if (srv.upgrade(req, { data })) return undefined as never;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/version") return new Response("bunvex");
      // Convex's health route: the deployment's name, as plain text (STUDY-34).
      if (url.pathname === "/instance_name") return new Response(engine.instanceName);
      // HTTP actions under /http (Convex's nest): the prefix is stripped; long requests are not cut by Bun's
      // idle timeout (the 408 at 300 s is the HTTP action's own).
      if (url.pathname.startsWith("/api/storage/") && files) {
        srv.timeout(req, 0);
        return serveStorage(files, req, url);
      }
      // Snapshot imports (STUDY-42): an upload streams to the blob store, and a one-shot import runs long.
      if (
        req.method === "POST" &&
        (url.pathname === "/api/import" ||
          url.pathname.startsWith("/api/import/") ||
          url.pathname === "/api/perform_import" ||
          url.pathname === "/api/cancel_import")
      ) {
        srv.timeout(req, 0);
        return importRoute(url, req);
      }
      // Every other route keeps the request body cap (H3) that Bun no longer applies on this server.
      const tooLarge = bodyCap(req);
      if (tooLarge) return tooLarge;
      if (url.pathname === "/http" || url.pathname.startsWith("/http/")) {
        srv.timeout(req, 0);
        return serveHttpAction(capped(req), url.pathname.slice(5) || "/", url.search);
      }
      // Snapshot exports (STUDY-42).
      if (url.pathname.startsWith("/api/export/")) return exportRoute(url, req);
      // Pushes (STUDY-35): Convex's deploy2 protocol, the Deploy operation.
      if (
        req.method === "POST" &&
        (url.pathname === "/api/get_config_hashes" || url.pathname.startsWith("/api/deploy2/"))
      )
        return pushRoute(url, req);
      // The admin API (STUDY-34): each route needs an admin key, and its operation.
      if (
        url.pathname === "/stats" ||
        url.pathname === "/api/check_admin_key" ||
        /^\/api\/cancel_(all_)?jobs?$/.test(url.pathname) ||
        /^\/api\/(v1\/)?(update|list)_environment_variables$/.test(url.pathname)
      ) {
        const caller = await callerOfRequest(req);
        if (caller instanceof Response) return caller;
        try {
          return await adminRoute(url, req, caller);
        } catch (e) {
          const r = accessError(e);
          if (r) return r;
          throw e;
        }
      }
      // The latest ts, for a consistent series of HTTP queries (Convex's `/api/query_ts`): base64 u64, as the
      // sync protocol encodes timestamps.
      if (url.pathname === "/api/query_ts" && req.method === "POST")
        return json({ ts: v1.encodeU64(wireTs(engine.committer.visibleTs)) });
      const route = /^\/api\/(query|mutation|action|query_at_ts|function)$/.exec(url.pathname);
      if (req.method !== "POST" || !route) return requestError(404, "NotFound", `no route for ${url.pathname}`);
      let body: { path: string; args: unknown; ts?: unknown };
      try {
        body = JSON.parse(await new Response(capped(req).body).text()) as typeof body;
      } catch (e) {
        return requestError(400, "BadJsonBody", `invalid JSON body: ${(e as Error).message}`);
      }
      if (typeof body?.path !== "string") return requestError(400, "BadJsonBody", "missing field `path`");
      let kind = route[1]!;
      const caller = await callerOfRequest(req);
      if (caller instanceof Response) return caller;
      // Convex's `/api/function` (`execute_any_function`): the function's own kind; an admin may run an
      // internal one (its key's operation is checked as for any call), others only public ones.
      if (kind === "function") {
        const found = functions.kindOf(body.path);
        if (!found || (!(caller as AdminCaller).admin && functions.isInternal(body.path)))
          return udfResponse(
            {
              ok: false,
              error: new FunctionPathError(
                `Could not find function for '${body.path.replace(/\.js(?=:|$)/, "").replace(/:default$/, "")}'. Did you forget to run \`bunvex dev\`?`,
              ),
              logLines: [],
            } as never,
            kind,
          );
        kind = found;
      }
      // A query at a ts `query_ts` gave (Convex's `/api/query_at_ts`): every such query reads one snapshot.
      let at: number | undefined;
      if (kind === "query_at_ts") {
        try {
          at = fromWireTs(v1.decodeU64(String(body.ts)));
        } catch (e) {
          return requestError(400, "BadJsonBody", `invalid field \`ts\`: ${(e as Error).message}`);
        }
        if (at > engine.committer.visibleTs)
          return requestError(400, "InvalidTimestamp", "The timestamp is ahead of the latest known timestamp");
      }
      return udfResponse(
        await collectLogs(async () => {
          const args = fromWire(body.args);
          if (kind === "query") return functions.runQueryJson(body.path, args, caller);
          if (kind === "query_at_ts") return functions.runQueryAtJson(body.path, args, at!, caller);
          const value =
            kind === "mutation"
              ? await functions.runMutation(body.path, args, true, caller)
              : await functions.runAction(body.path, args, caller);
          return stringifyValue(value);
        }),
        kind,
      );
    },
  });
  // The file storage, once the API's origin is known (its URLs start with it).
  const blobs =
    opts.fileStorage === undefined
      ? blobStoreFromEnv(process.env, {
          s3Prefix: () => engine.instanceSetting("s3Prefix", () => `bunvex-${crypto.randomUUID()}/`),
        })
      : opts.fileStorage;
  const cloudOrigin = opts.cloudOrigin ?? process.env.BUNVEX_CLOUD_ORIGIN ?? `http://127.0.0.1:${server.port}`;
  if (blobs) {
    files = new FileStorage(engine, blobs, cloudOrigin.replace(/\/$/, ""));
    functions.fileStorage = files;
  }
  const stopFileSweeps = files ? startFileSweeps(engine, files) : () => {};

  // The site port (Convex's site proxy): HTTP actions at every path; `/version` first, as Convex's meta route.
  const sitePort =
    opts.sitePort === undefined
      ? server.port === undefined
        ? null
        : opts.port === 0
          ? 0
          : server.port + 1
      : opts.sitePort;
  const site =
    sitePort === null
      ? null
      : Bun.serve({
          port: sitePort,
          ...(opts.hostname ? { hostname: opts.hostname } : {}),
          idleTimeout: 120,
          ...(opts.maxRequestBodySize === undefined ? {} : { maxRequestBodySize: opts.maxRequestBodySize }),
          fetch(req, srv) {
            const url = new URL(req.url);
            if (url.pathname === "/version") return new Response("bunvex");
            srv.timeout(req, 0);
            return serveHttpAction(req, url.pathname, url.search);
          },
        });
  /** The site's origin: Convex's `CONVEX_SITE_URL` default. */
  const siteOrigin = site
    ? (opts.siteOrigin ?? process.env.BUNVEX_SITE_ORIGIN ?? `http://127.0.0.1:${site.port}`)
    : null;
  /** The built-in variables (STUDY-37 E2): always set, never settable. */
  const builtinEnv: Record<string, string> = {
    BUNVEX_CLOUD_URL: cloudOrigin.replace(/\/$/, ""),
    ...(siteOrigin ? { BUNVEX_SITE_URL: siteOrigin.replace(/\/$/, "") } : {}),
  };
  functions.builtinEnv = builtinEnv;
  functions.httpRoutes = () => (httpOptions.router?.getRoutes() ?? []).map(([path, method]) => [method, path] as const);
  /** The deployment's variables with the built-ins, as `auth.config` sees them. */
  const deploymentEnv = async () => ({
    ...builtinEnv,
    ...Object.fromEntries(await engine.query((db) => engine.environment.snapshot(db))),
  });
  /** The deployed `auth.config.js`, re-evaluated when a variable changes (Convex's `reevaluate_existing_auth_config`). */
  let authModule: ModuleSource | null = null;
  const useAuth = (providers: unknown[] | null) => {
    verifier = makeVerifier(providers === null ? undefined : ({ providers } as AuthConfig));
  };
  /**
   * Make a code version live (STUDY-35): its functions replace every function at once, its router the
   * HTTP actions', its crons the stored ones (the same diff as at start); then every subscription to a
   * changed module runs again. Requests already running finish on the code they started with.
   */
  /** Pushed code packages: their own use case of the blob store, apart from user files (STUDY-35). */
  const modulesStore =
    opts.moduleStorage ??
    blobStoreFromEnv(process.env, {
      useCase: "modules",
      s3Prefix: () => engine.instanceSetting("s3Prefix", () => `bunvex-${crypto.randomUUID()}/`),
    });
  /** Snapshot exports (STUDY-42). */
  const exportStore =
    opts.exportStorage === undefined
      ? blobStoreFromEnv(process.env, {
          useCase: "exports",
          s3Prefix: () => engine.instanceSetting("s3Prefix", () => `bunvex-${crypto.randomUUID()}/`),
        })
      : opts.exportStorage;
  const exportService = exportStore
    ? new ExportService(engine, exportStore, blobs ?? null, {
        deploymentName: engine.instanceName,
        ...(process.env.TMPDIR ? { tmpDir: process.env.TMPDIR } : {}),
      })
    : null;
  exportService?.start();
  exportRoute = async (url: URL, req: Request): Promise<Response> => {
    if (!exportService) return requestError(404, "NotFound", "Snapshot exports are not configured on this server.");
    const parts = url.pathname.replace(/^\/api\/export\//, "").split("/");
    try {
      // A download by token (a browser's) needs no admin key.
      const token = url.searchParams.get("token");
      if (req.method === "GET" && parts[0] === "zip" && parts.length === 2) {
        if (token !== null) {
          if (!exportService.checkToken(parts[1]!, token))
            return requestError(403, "InvalidExportToken", "The export download token is invalid or expired.");
          return await exportService.download(parts[1]!);
        }
        const caller = await callerOfRequest(req);
        if (caller instanceof Response) return caller;
        functions.requireOperation(caller, "DownloadBackups");
        return await exportService.download(parts[1]!);
      }
      if (req.method !== "POST") return requestError(404, "NotFound", `no route for ${url.pathname}`);
      const caller = await callerOfRequest(req);
      if (caller instanceof Response) return caller;
      if (parts[0] === "request" && parts[1] === "zip" && parts.length === 2) {
        functions.requireOperation(caller, "CreateBackups");
        await exportService.request(url.searchParams.get("includeStorage") === "true");
        return new Response(null, { status: 200 });
      }
      if (parts[0] === "zip" && parts[2] === "token" && parts.length === 3) {
        functions.requireOperation(caller, "DownloadBackups");
        return json({ token: await exportService.token(parts[1]!) });
      }
      if (parts[0] === "set_expiration" && parts.length === 2) {
        functions.requireOperation(caller, "DeleteBackups");
        const body = JSON.parse((await new Response(capped(req).body).text()) || "{}") as { expirationTsNs?: unknown };
        if (typeof body.expirationTsNs !== "number" && typeof body.expirationTsNs !== "string")
          return requestError(400, "BadJsonBody", "missing field `expirationTsNs`");
        await exportService.setExpiration(parts[1]!, BigInt(body.expirationTsNs));
        return new Response(null, { status: 200 });
      }
      if (parts[0] === "cancel" && parts.length === 2) {
        // Convex checks ImportBackups here.
        functions.requireOperation(caller, "ImportBackups");
        await exportService.cancel(parts[1]!);
        return new Response(null, { status: 200 });
      }
      return requestError(404, "NotFound", `no route for ${url.pathname}`);
    } catch (e) {
      if (e instanceof ExportError) return requestError(e.status, e.code, e.message);
      const denied = accessError(e);
      if (denied) return denied;
      throw e;
    }
  };
  /** Snapshot imports (STUDY-42). */
  const importStore =
    opts.importStorage === undefined
      ? blobStoreFromEnv(process.env, {
          useCase: "snapshot_imports",
          s3Prefix: () => engine.instanceSetting("s3Prefix", () => `bunvex-${crypto.randomUUID()}/`),
        })
      : opts.importStorage;
  const importService = importStore
    ? new ImportService(engine, importStore, blobs ?? null, opts.importOptions ?? {})
    : null;
  importService?.startWorker();
  /** Convex's `parse_format_arg`. */
  const importFormat = (format: string | null, table: string | null): ImportFormat => {
    if (table !== null && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(table))
      throw new ImportRequestError(400, "ImportInvalidName", `invalid table name ${table}: not a valid table name`);
    const needs = (what: string) => {
      if (table === null) throw new ImportRequestError(400, "InvalidName", `${what} import requires table name`);
      return table;
    };
    switch (format) {
      case "zip":
        if (table !== null) throw new ImportRequestError(400, "InvalidName", "ZIP import cannot have table name");
        return { format: "zip" };
      case "csv":
        return { format: "csv", table: needs("CSV") };
      case "jsonArray":
        return { format: "json_array", table: needs("JSON") };
      case "jsonLines":
        return { format: "jsonl", table: needs("JSONL") };
      default:
        throw new ImportRequestError(
          400,
          "BadQueryArgs",
          `unknown variant \`${format}\`, expected one of \`csv\`, \`jsonLines\`, \`jsonArray\`, \`zip\``,
        );
    }
  };
  const importArgs = (a: { format?: unknown; tableName?: unknown; mode?: unknown; componentPath?: unknown }) => {
    if (a.componentPath !== undefined && a.componentPath !== null && a.componentPath !== "")
      throw new ImportRequestError(
        400,
        "ComponentsNotSupported",
        "bunvex does not have components yet: import into the app's own tables.",
      );
    const mode = MODE_ARGS[(a.mode as string | undefined) ?? "requireEmpty"];
    if (!mode)
      throw new ImportRequestError(
        400,
        "BadQueryArgs",
        `unknown variant \`${String(a.mode)}\`, expected one of \`append\`, \`replace\`, \`replaceAll\`, \`requireEmpty\``,
      );
    const table = typeof a.tableName === "string" ? a.tableName : null;
    return { format: importFormat(typeof a.format === "string" ? a.format : null, table), mode };
  };
  importRoute = async (url: URL, req: Request): Promise<Response> => {
    if (!importService) return requestError(404, "NotFound", "Snapshot imports are not configured on this server.");
    try {
      const caller = await callerOfRequest(req);
      if (caller instanceof Response) return caller;
      functions.requireOperation(caller, "ImportBackups");
      const q = url.searchParams;
      const body = async () => JSON.parse((await req.text()) || "{}") as Record<string, unknown>;
      switch (url.pathname) {
        case "/api/import": {
          const { format, mode } = importArgs({
            format: q.get("format"),
            tableName: q.get("tableName") ?? undefined,
            mode: q.get("mode") ?? undefined,
            componentPath: q.get("componentPath") ?? undefined,
          });
          const upload = await importService.upload(req.body ?? new Uint8Array());
          return json({ numWritten: await importService.importNow(format, mode, upload) });
        }
        case "/api/import/start_upload":
          return json({ uploadToken: importService.startUpload() });
        case "/api/import/upload_part": {
          const token = q.get("uploadToken");
          if (!token || !q.get("partNumber"))
            throw new ImportRequestError(400, "BadQueryArgs", "missing field `uploadToken` or `partNumber`");
          return json(await importService.uploadPart(token, new Uint8Array(await req.arrayBuffer())));
        }
        case "/api/import/finish_upload": {
          const b = await body();
          const { format, mode } = importArgs((b.import ?? {}) as Record<string, unknown>);
          if (typeof b.uploadToken !== "string" || !Array.isArray(b.partTokens))
            throw new ImportRequestError(400, "BadJsonBody", "missing field `uploadToken` or `partTokens`");
          const upload = await importService.finishUpload(b.uploadToken, b.partTokens as string[]);
          return json({ importId: await importService.start(format, mode, upload) });
        }
        case "/api/perform_import":
        case "/api/cancel_import": {
          const { importId } = await body();
          let valid = typeof importId === "string";
          try {
            if (valid) decodeId(importId as string);
          } catch {
            valid = false;
          }
          if (!valid) throw new ImportRequestError(400, "InvalidImport", `invalid import id ${String(importId)}`);
          if (url.pathname === "/api/perform_import") await importService.perform(importId as string);
          else await importService.cancel(importId as string);
          return new Response(null, { status: 200 });
        }
      }
      return requestError(404, "NotFound", `no route for ${url.pathname}`);
    } catch (e) {
      if (e instanceof ImportRequestError) return requestError(e.status, e.code, e.message);
      if (e instanceof ImportError) return requestError(400, e.code, e.message);
      if (e instanceof SyntaxError) return requestError(400, "BadJsonBody", e.message);
      const denied = accessError(e);
      if (denied) return denied;
      throw e;
    }
  };
  /**
   * Deploy a push's modules (STUDY-35): load and analyze them (nothing changes if that fails), store the
   * package, commit the module rows, then make the version live. Unused packages are deleted after.
   */
  const deployCode = async (modules: ModuleSource[]) => {
    const config = await udfConfig(engine);
    const version = await CodeVersion.load(modules, { seed: config.seed, timestamp: config.timestamp });
    const pkg = await writePackage(modulesStore, modules);
    let unused: SourcePackage[];
    try {
      unused = await engine.mutation((db) => writeCodeRows(db, pkg, version), "push");
    } catch (e) {
      await modulesStore.delete(pkg.storageKey).catch(() => {});
      throw e;
    }
    const live = await installCodeVersion(version);
    for (const p of unused) await modulesStore.delete(p.storageKey).catch(() => {});
    return { version, ...live };
  };
  /** A deployable server's code: the latest version in the store, live once this resolves. */
  const codeReady: Promise<void> = opts.deployable
    ? deploymentEnv().then(async (env) => {
        const code = await loadLatestCode(engine, modulesStore, env);
        if (!code) return;
        await installCodeVersion(code.version);
        authModule = code.authConfig;
        if (authModule) useAuth(await evaluateAuthConfig(engine, authModule, env));
      })
    : Promise.resolve();
  codeReady.catch((e) =>
    console.error(`bunvex: could not load the deployed code: ${e instanceof Error ? e.message : e}`),
  );

  const installCodeVersion = async (version: CodeVersion, o: { crons?: boolean; auth?: unknown[] | null } = {}) => {
    const changed = functions.install(version.functions, version.moduleHashes);
    httpOptions.router = version.router;
    if (o.auth !== undefined)
      verifier = makeVerifier(o.auth === null ? undefined : ({ providers: o.auth } as AuthConfig));
    const crons =
      o.crons === false
        ? undefined
        : await cronExecutor.push(
            version.crons ? cronSpecs(version.crons, (id, name) => functions.cronTarget(id, name)) : new Map(),
          );
    sync.invalidateModules(changed);
    return { changed, crons };
  };
  /** Pushes over HTTP (Convex's deploy2 protocol), for a deployable server. */
  const push = new PushService({
    engine,
    modulesStore,
    cronExecutor,
    install: (version, auth, module) => {
      authModule = module;
      return installCodeVersion(version, { crons: false, auth });
    },
    deploymentEnv,
  });
  envRoute = async (url, req, caller) => {
    if (url.pathname.endsWith("/list_environment_variables")) {
      if (req.method !== "GET") return requestError(404, "NotFound", `no route for ${url.pathname}`);
      functions.requireOperation(caller, "ViewEnvironmentVariables");
      const vars = await engine.query((db) => engine.environment.list(db));
      return json({ environmentVariables: Object.fromEntries(vars.map((v) => [v.name, v.value])) });
    }
    if (req.method !== "POST") return requestError(404, "NotFound", `no route for ${url.pathname}`);
    functions.requireOperation(caller, "WriteEnvironmentVariables");
    let changes: EnvVarChange[];
    try {
      const body = JSON.parse(await new Response(capped(req).body).text()) as { changes?: unknown };
      if (!Array.isArray(body?.changes)) return requestError(400, "BadJsonBody", "missing field `changes`");
      changes = body.changes.map((c: { name?: unknown; value?: unknown }) => {
        if (typeof c?.name !== "string") throw new Error("missing field `name`");
        if (c.value !== undefined && c.value !== null && typeof c.value !== "string")
          throw new Error("invalid type for `value`: expected a string or null");
        return { name: c.name, value: (c.value as string | null | undefined) ?? null };
      });
    } catch (e) {
      return requestError(400, "BadJsonBody", `invalid JSON body: ${(e as Error).message}`);
    }
    try {
      // Convex re-evaluates the deployed auth config in the update's transaction. Evaluating code cannot run
      // inside one here (its import phase draws randomness), so it is evaluated first with the variables the
      // batch would leave, and the batch commits only if the variables it started from are still the
      // deployment's (else it starts over).
      let providers: unknown[] | null = null;
      for (let attempt = 0; ; attempt++) {
        const base = await engine.query((db) => engine.environment.list(db));
        const after = new Map(base.map((v) => [v.name, v.value]));
        for (const c of changes) if (c.value === null) after.delete(c.name);
        for (const c of changes) if (c.value !== null) after.set(c.name, c.value);
        // The batch's own checks first, so that a bad name is reported as such, not as an auth config error.
        await engine.query(async (db) => engine.environment.check(db, changes, Object.keys(builtinEnv)));
        if (authModule)
          providers = await evaluateAuthConfig(
            engine,
            authModule,
            { ...builtinEnv, ...Object.fromEntries(after) },
            "This change would make the auth config invalid",
          );
        const same = await engine.mutation(async (db) => {
          const now = await engine.environment.list(db);
          if (JSON.stringify(now) !== JSON.stringify(base)) return false;
          await engine.environment.update(db, changes, Object.keys(builtinEnv));
          return true;
        }, "update_env_vars");
        if (same) break;
        if (attempt >= 4) return requestError(409, "RaceDetected", "Environment variables changed during the update");
      }
      if (authModule) useAuth(providers);
      return new Response(null, { status: 200 });
    } catch (e) {
      if (e instanceof EnvironmentVariableError || e instanceof PushError) return requestError(400, e.code, e.message);
      throw e;
    }
  };
  pushRoute = async (url: URL, req: Request): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = (JSON.parse((await new Response(capped(req).body).text()) || "{}") ?? {}) as Record<string, unknown>;
    } catch (e) {
      return requestError(400, "BadJsonBody", `invalid JSON body: ${(e as Error).message}`);
    }
    // The admin key in the header, or (as Convex's CLI also sends it) in the body.
    let caller = await callerOfRequest(req);
    if (caller instanceof Response) return caller;
    if (!(caller as AdminCaller).admin && typeof body.adminKey === "string") {
      try {
        caller = adminCaller(body.adminKey, false);
      } catch (e) {
        const r = accessError(e);
        if (r) return r;
        throw e;
      }
    }
    try {
      functions.requireOperation(caller, "Deploy");
      if (!opts.deployable)
        return requestError(400, "NotDeployable", "This deployment's functions are not deployed by pushes.");
      await codeReady;
      const step = url.pathname.replace(/^\/api\/(deploy2\/)?/, "");
      if (step === "get_config_hashes") return json(await push.configHashes());
      if (step === "start_push") return json(await push.startPush(body));
      if (step === "evaluate_push") return json(await push.startPush({ ...body, dryRun: true }));
      if (step === "wait_for_schema") return json(await push.waitForSchema(body));
      if (step === "finish_push") return json(await push.finishPush(body));
      if (step === "report_push_completed") return json({});
      return requestError(404, "NotFound", `no route for ${url.pathname}`);
    } catch (e) {
      if (e instanceof PushError)
        return requestError(
          e.status,
          e.code,
          e.code === "RaceDetected" ? e.message : `Hit an error while pushing:\n${e.message}`,
        );
      const r = accessError(e);
      if (r) return r;
      throw e;
    }
  };

  return {
    installCodeVersion,
    deployCode,
    codeReady,
    server,
    /** The site port's server (HTTP actions), if any. */
    site,
    /** The site's origin, as Convex's `CONVEX_SITE_URL` default. */
    siteUrl: siteOrigin,
    /** The API's public origin (file URLs start with it). */
    cloudOrigin,
    /** The file storage, if any. */
    files,
    sync,
    scheduler,
    cronsReady,
    stop: () => {
      void exportService?.stop();
      void importService?.stop();
      void scheduler.stop();
      void cronExecutor.stop();
      stopCleanup();
      stopFileSweeps();
      sync.stop();
      site?.stop(true);
      server?.stop(true);
    },
    /** A clean exit: stop serving, let the last commits land, release the store's lease (PERSIST-01 C7, so
     *  a replacement process opens at once instead of after the lease's TTL) and close the store. */
    shutdown: async () => {
      await exportService?.stop();
      await importService?.stop();
      await scheduler.stop();
      await cronExecutor.stop();
      sync.stop();
      site?.stop(true);
      server?.stop(true);
      stopFileSweeps();
      await engine.close();
    },
  };
}

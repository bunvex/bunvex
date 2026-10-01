// The transports: the HTTP one-shot API (Convex's `/api/{query,mutation,action}` shape) and the sync
// protocol v1 at `/api/{version}/sync` (sync.ts, STUDY-23). One process: the committer is single by design.
import { type AuthConfig, AuthenticationError, parseAuthConfig, TokenVerifier } from "@bunvex/auth";
import { type Caller, type Engine, OccError, parseValue, stringifyValue } from "@bunvex/core";
import { v1 } from "@bunvex/protocol";
import type { Server } from "bun";
import { clientError, INTERNAL_SERVER_ERROR_MESSAGE, isSystemError, withRequestId } from "./errors.ts";
import { callerOf, type Functions } from "./functions.ts";
import { collectLogs, type WithLogLines } from "./logs.ts";
import { sessionRetentionFromEnv, startSessionCleanup } from "./session-cleanup.ts";
import {
  fromWireTs,
  MAX_PENDING_MUTATIONS,
  type SplayOptions,
  SyncHub,
  SyncSession,
  splayOptions,
  wireTs,
} from "./sync.ts";

export { MAX_PENDING_MUTATIONS };

/** A socket's state: its sync session. */
type WsData = { session: SyncSession };

export type ServerOptions = {
  engine: Engine;
  functions: Functions;
  port?: number;
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
  const verifier = new TokenVerifier(opts.auth === undefined ? [] : parseAuthConfig(opts.auth), {
    redactErrors: redact,
    ...(opts.authFetch ? { fetch: opts.authFetch } : {}),
  });
  /**
   * The caller of an HTTP request, from its `Authorization` header (Convex's `ExtractAuthenticationToken`):
   * `Bearer <jwt>` is a user, verified against the auth config; no header is no identity. A failure is the
   * request's error response.
   */
  const callerOfRequest = async (req: Request): Promise<Caller | Response> => {
    const header = req.headers.get("authorization");
    if (header === null) return callerOf(null);
    if (header.length < 7) return requestError(400, "InvalidHeaderFailure", "Invalid authentication header");
    const scheme = header.slice(0, 7).toLowerCase();
    // Admin keys (`Bunvex <key>`, DV-97) come with Phase 3's admin keys; until then they are refused.
    if (scheme === "bunvex ") return requestError(401, "Unauthenticated", "Admin keys are not supported yet");
    if (scheme !== "bearer " || header.length === 7) return requestError(400, "InvalidAdminKey", "Invalid admin key");
    try {
      return callerOf((await verifier.verify(header.slice(7).trim())).identity);
    } catch (e) {
      if (e instanceof AuthenticationError) return requestError(e.status, e.code, e.message);
      throw e;
    }
  };
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
    if (r.ok) return jsonText(`{"status":"success","value":${r.value}${linesField("logLines", r.logLines, redact)}}`);
    if (isSystemError(r.error)) return requestError(500, "InternalServerError", INTERNAL_SERVER_ERROR_MESSAGE);
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
  });
  const stopCleanup = startSessionCleanup(
    engine,
    opts.sessionRequestRetentionMs === undefined ? sessionRetentionFromEnv() : opts.sessionRequestRetentionMs,
  );

  server = Bun.serve<WsData, never>({
    port: opts.port ?? 3210,
    idleTimeout: 120,
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
      if (url.pathname === "/stats") {
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
      // The latest ts, for a consistent series of HTTP queries (Convex's `/api/query_ts`): base64 u64, as the
      // sync protocol encodes timestamps.
      if (url.pathname === "/api/query_ts" && req.method === "POST")
        return json({ ts: v1.encodeU64(wireTs(engine.committer.visibleTs)) });
      const route = /^\/api\/(query|mutation|action|query_at_ts)$/.exec(url.pathname);
      if (req.method !== "POST" || !route) return requestError(404, "NotFound", `no route for ${url.pathname}`);
      let body: { path: string; args: unknown; ts?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch (e) {
        return requestError(400, "BadJsonBody", `invalid JSON body: ${(e as Error).message}`);
      }
      if (typeof body?.path !== "string") return requestError(400, "BadJsonBody", "missing field `path`");
      const kind = route[1];
      const caller = await callerOfRequest(req);
      if (caller instanceof Response) return caller;
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
  return {
    server,
    sync,
    stop: () => {
      stopCleanup();
      sync.stop();
      server?.stop(true);
    },
    /** A clean exit: stop serving, let the last commits land, release the store's lease (PERSIST-01 C7, so
     *  a replacement process opens at once instead of after the lease's TTL) and close the store. */
    shutdown: async () => {
      sync.stop();
      server?.stop(true);
      await engine.close();
    },
  };
}

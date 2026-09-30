// The transports: the HTTP one-shot API (Convex's `/api/{query,mutation,action}` shape) and the WebSocket
// sync protocol, both speaking @bunvex/protocol v0. One process: the committer is single by design.
import {
  type Engine,
  type FormatError,
  OccError,
  parseValue,
  type SubResult,
  Subscriptions,
  stringifyValue,
} from "@bunvex/core";
import { type ClientMessage, subscriptionKey } from "@bunvex/protocol";
import type { Server, ServerWebSocket } from "bun";
import { clientError, INTERNAL_SERVER_ERROR_MESSAGE, isSystemError, withRequestId } from "./errors.ts";
import type { Functions } from "./functions.ts";
import { collectLogs, type WithLogLines, withoutLogs } from "./logs.ts";

/**
 * One connection's state. `mutations` is the tail of its mutation queue: as in Convex's sync worker
 * (`mutation_futures … buffered(1)`, crates/sync/src/worker.rs), a connection's mutations run one at a
 * time, in the order they arrived (STUDY-22).
 */
type WsData = { keys: Set<string>; mutations: Promise<void>; pendingMutations: number; closed: boolean };

/** Mutations one connection may have queued or running (Convex's OPERATION_QUEUE_BUFFER_SIZE). */
export const MAX_PENDING_MUTATIONS = 1000;
/** Close code for "try again later" (RFC 6455 1013), which Convex uses for rate-limit errors. */
const CLOSE_TRY_AGAIN_LATER = 1013;

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
};

/**
 * Arguments arrive in Convex's JSON form ($integer, $float, $bytes); functions receive Convex values. As in
 * Convex (`UdfArgsJson`), `args` is the arguments object or an array holding it (what Convex's clients send).
 */
const fromWire = (args: unknown) => parseValue(JSON.stringify((Array.isArray(args) ? args[0] : args) ?? {}));

const envFlag = (v: string | undefined) => v !== undefined && v !== "" && v !== "false" && v !== "0";

/** `,"<field>":[…]` for the log lines a client may see, or nothing (Convex omits empty `logLines`). */
const linesField = (field: string, lines: string[], redact: boolean) =>
  redact || lines.length === 0 ? "" : `,${JSON.stringify(field)}:${JSON.stringify(lines)}`;

export function createServer(opts: ServerOptions) {
  const { engine, functions } = opts;
  const redact = opts.redactLogsToClient ?? envFlag(process.env.REDACT_LOGS_TO_CLIENT);
  /** A failed function run, for a client: the message (without its request id) and the app's data. */
  const formatError: FormatError = (e) => {
    if (isSystemError(e)) return { error: INTERNAL_SERVER_ERROR_MESSAGE };
    const c = clientError(e, redact);
    return c.data === undefined ? { error: c.message } : { error: c.message, data: JSON.stringify(c.data) };
  };
  /** `,"e":…` (+ `,"d":…`) of a WebSocket frame carrying an error. */
  const errorFields = (r: { error: string; data?: string }) =>
    `,"e":${JSON.stringify(withRequestId(r.error))}${r.data === undefined ? "" : `,"d":${r.data}`}`;
  const subFrame = (key: string, r: SubResult) =>
    "value" in r
      ? `{"t":"upd","k":${JSON.stringify(key)},"v":${r.value}}`
      : `{"t":"err","k":${JSON.stringify(key)}${errorFields(r)}}`;
  engine.committer.onFatal(
    opts.onFatal ??
      ((e) => {
        console.error(`bunvex: ${e.message}; shutting down`, e.cause);
        process.exit(1);
      }),
  );
  let server: Server<WsData> | null = null;
  // Fan-out rides on Bun's native pub/sub: one topic per subscription key.
  const subs = new Subscriptions(engine, (key, msg) => server?.publish(key, subFrame(key, msg)), formatError);

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

  /** Run one WebSocket mutation and send its `res` frame. Never throws. */
  const runWsMutation = async (ws: ServerWebSocket<WsData>, id: number, path: string, args: unknown) => {
    const r = await collectLogs(async () => stringifyValue(await functions.runMutation(path, fromWire(args))));
    if (ws.data.closed) return;
    const lines = linesField("l", r.logLines, redact);
    if (r.ok) ws.send(`{"t":"res","id":${JSON.stringify(id)},"v":${r.value}${lines}}`);
    else {
      // An exhausted OCC budget is not the function's error: Convex ends the connection with it
      // (STUDY-21 D2); v0 sends its message as the result.
      const e = r.error instanceof OccError ? { error: r.error.message } : formatError(r.error);
      ws.send(`{"t":"res","id":${JSON.stringify(id)}${errorFields(e)}${lines}}`);
    }
  };

  server = Bun.serve<WsData, never>({
    port: opts.port ?? 3210,
    idleTimeout: 120,
    websocket: {
      maxPayloadLength: 8 * 1024 * 1024,
      idleTimeout: 960,
      async message(ws, raw) {
        let m: ClientMessage;
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (m.t === "sub") {
          const key = subscriptionKey(m.path, m.args);
          const send = (r: SubResult | null) => {
            if (r !== null) ws.send(subFrame(key, r));
          };
          // Already subscribed on this socket: one reference per socket and key, just resend the result.
          if (ws.data.keys.has(key)) return send(subs.current(key));
          ws.subscribe(key); // join the topic BEFORE the first run publishes to it
          ws.data.keys.add(key);
          let current: SubResult | null;
          try {
            const body = functions.queryBody(m.path, fromWire(m.args));
            // A subscription's runs belong to no caller: a re-run triggered by a mutation's commit must not
            // add its console lines to that mutation's logLines.
            current = await subs.subscribe(key, (db) => withoutLogs(() => body(db)));
          } catch (e) {
            send(formatError(e));
            return;
          }
          send(current);
        } else if (m.t === "unsub") {
          const key = subscriptionKey(m.path, m.args);
          if (ws.data.keys.delete(key)) {
            ws.unsubscribe(key);
            subs.unsubscribe(key);
          }
        } else if (m.t === "mut") {
          const { id, path, args } = m;
          const conn = ws.data;
          // Convex refuses the 1001st pending mutation with a rate-limit error that ends the connection
          // ("TooManyConcurrentMutations", close code 1013).
          if (conn.pendingMutations >= MAX_PENDING_MUTATIONS) {
            ws.close(CLOSE_TRY_AGAIN_LATER, "TooManyConcurrentMutations");
            return;
          }
          conn.pendingMutations++;
          // Queued synchronously, before any await, so the queue order is the order frames arrived.
          conn.mutations = conn.mutations.then(async () => {
            try {
              // A closed connection's queued mutations never start, as when Convex drops the worker; the
              // client re-sends what it did not get an answer for.
              if (!conn.closed) await runWsMutation(ws, id, path, args);
            } finally {
              conn.pendingMutations--;
            }
          });
        }
      },
      close(ws) {
        ws.data.closed = true;
        for (const k of ws.data.keys) subs.unsubscribe(k);
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const data: WsData = { keys: new Set(), mutations: Promise.resolve(), pendingMutations: 0, closed: false };
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
          subs: subs.size,
          ...subs.stats,
        });
      }
      const route = /^\/api\/(query|mutation|action)$/.exec(url.pathname);
      if (req.method !== "POST" || !route) return requestError(404, "NotFound", `no route for ${url.pathname}`);
      let body: { path: string; args: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch (e) {
        return requestError(400, "BadJsonBody", `invalid JSON body: ${(e as Error).message}`);
      }
      if (typeof body?.path !== "string") return requestError(400, "BadJsonBody", "missing field `path`");
      const kind = route[1];
      return udfResponse(
        await collectLogs(async () => {
          const args = fromWire(body.args);
          if (kind === "query") return functions.runQueryJson(body.path, args);
          const value =
            kind === "mutation"
              ? await functions.runMutation(body.path, args)
              : await functions.runAction(body.path, args);
          return stringifyValue(value);
        }),
        kind,
      );
    },
  });
  return { server, subscriptions: subs, stop: () => server?.stop(true) };
}

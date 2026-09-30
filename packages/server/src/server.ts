// The transports: the HTTP one-shot API (Convex's `/api/{query,mutation,action}` shape) and the WebSocket
// sync protocol, both speaking @bunvex/protocol v0. One process: the committer is single by design.
import { type Engine, jsonToValue, Subscriptions, valueToJson } from "@bunvex/core";
import { type ClientMessage, subscriptionKey } from "@bunvex/protocol";
import type { Server } from "bun";
import type { Functions } from "./functions.ts";

type WsData = { keys: Set<string> };

export type ServerOptions = {
  engine: Engine;
  functions: Functions;
  port?: number;
  label?: string;
  /** What to do when persistence fails and the committer stops. Default: log and exit(1), as Convex does, so
   *  a supervisor restarts the process and it recovers from what persistence durably holds. */
  onFatal?: (e: Error) => void;
};

/** Arguments arrive in Convex's JSON form ($integer, $float, $bytes); functions receive Convex values. */
const fromWire = (args: unknown) => jsonToValue(JSON.stringify(args ?? {}));

export function createServer(opts: ServerOptions) {
  const { engine, functions } = opts;
  engine.committer.onFatal(
    opts.onFatal ??
      ((e) => {
        console.error(`bunvex: ${e.message}; shutting down`, e.cause);
        process.exit(1);
      }),
  );
  let server: Server<WsData> | null = null;
  // Fan-out rides on Bun's native pub/sub: one topic per subscription key.
  const subs = new Subscriptions(engine, (key, msg) =>
    server?.publish(
      key,
      "value" in msg
        ? `{"t":"upd","k":${JSON.stringify(key)},"v":${msg.value}}`
        : JSON.stringify({ t: "err", k: key, e: msg.error }),
    ),
  );

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
          const send = (r: { value: string } | { error: string } | null) => {
            if (r === null) return;
            ws.send(
              "value" in r
                ? `{"t":"upd","k":${JSON.stringify(key)},"v":${r.value}}`
                : JSON.stringify({ t: "err", k: key, e: r.error }),
            );
          };
          // Already subscribed on this socket: one reference per socket and key, just resend the result.
          if (ws.data.keys.has(key)) return send(subs.current(key));
          ws.subscribe(key); // join the topic BEFORE the first run publishes to it
          ws.data.keys.add(key);
          let current: { value: string } | { error: string } | null;
          try {
            current = await subs.subscribe(key, functions.queryBody(m.path, fromWire(m.args)));
          } catch (e) {
            ws.send(JSON.stringify({ t: "err", k: key, e: String((e as Error).message ?? e) }));
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
          try {
            const v = await functions.runMutation(m.path, fromWire(m.args));
            ws.send(`{"t":"res","id":${JSON.stringify(m.id)},"v":${valueToJson(v)}}`);
          } catch (e) {
            ws.send(JSON.stringify({ t: "res", id: m.id, e: String((e as Error).message ?? e) }));
          }
        }
      },
      close(ws) {
        for (const k of ws.data.keys) subs.unsubscribe(k);
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: { keys: new Set<string>() } })) return undefined as never;
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
      if (req.method !== "POST" || !route) return json({ status: "error", errorMessage: "not found" }, 404);
      let body: { path: string; args: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ status: "error", errorMessage: "invalid json" }, 400);
      }
      try {
        if (route[1] === "query") {
          const v = await functions.runQueryJson(body.path, fromWire(body.args));
          return new Response(`{"status":"success","value":${v}}`, { headers: { "content-type": "application/json" } });
        }
        const value =
          route[1] === "mutation"
            ? await functions.runMutation(body.path, fromWire(body.args))
            : await functions.runAction(body.path, fromWire(body.args));
        return new Response(`{"status":"success","value":${valueToJson(value)}}`, {
          headers: { "content-type": "application/json" },
        });
      } catch (e) {
        return json({ status: "error", errorMessage: String((e as Error).message ?? e) }, 500);
      }
    },
  });
  return { server, subscriptions: subs, stop: () => server?.stop(true) };
}

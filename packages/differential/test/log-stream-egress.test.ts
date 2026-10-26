// Log stream egress (STUDY-187 X6) on Convex's backend (the oracle) and on bunvex's: a webhook stream gets one
// `log_stream_egress` event a minute (Convex's fixed 60 s), `{timestamp, topic, egress_bytes}` beside the
// deployment metadata, whose `egress_bytes` are the bodies sent before it, the connection test left out. Slow (a
// minute and a bit, both backends at once). Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`log-stream-egress: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

let convex: Backend;
let bunvex: Backend;
const stops: (() => void)[] = [];

const authOf = (b: Backend) => `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;

async function req(b: Backend, method: string, path: string, body?: unknown) {
  const r = await fetch(`${b.url}${path}`, {
    method,
    headers: { authorization: authOf(b), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return r.json() as Promise<Record<string, unknown>>;
}

/** A webhook endpoint recording each body. */
function receiver() {
  const got: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(r) {
      got.push(await r.text());
      return new Response(null, { status: 200 });
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/hook`, got };
}

type Seen = { keys: string[]; topic: unknown; egressBytes: unknown; counted: number; verificationLeftOut: boolean };

/** Create a webhook stream, run a function, and wait for the first egress event: what it says, and what was sent. */
async function observe(b: Backend): Promise<Seen> {
  const hook = receiver();
  const { id } = await req(b, "POST", "/api/v1/create_log_stream", {
    logStreamType: "webhook",
    url: hook.url,
    format: "json",
  });
  for (let i = 0; i < 500; i++) {
    const s = (await req(b, "GET", `/api/v1/get_log_stream/${id}`)) as { status: { type: string } };
    if (s.status.type === "active") break;
    await Bun.sleep(10);
  }
  await b.call("query", "ops:dump", {});
  for (let i = 0; i < 900; i++) {
    const at = hook.got.findIndex((body) =>
      (JSON.parse(body) as { topic: string }[]).some((e) => e.topic === "log_stream_egress"),
    );
    if (at >= 0) {
      const event = (JSON.parse(hook.got[at]!) as Record<string, unknown>[]).find(
        (e) => e.topic === "log_stream_egress",
      )!;
      const bodies = hook.got.slice(0, at);
      const isVerification = (body: string) => (JSON.parse(body) as { topic: string }[])[0]?.topic === "verification";
      const counted = bodies.filter((x) => !isVerification(x)).reduce((n, x) => n + Buffer.byteLength(x), 0);
      const all = bodies.reduce((n, x) => n + Buffer.byteLength(x), 0);
      return {
        // The deployment metadata's key differs on purpose (DV-304: `convex` there, `deployment` here).
        keys: Object.keys(event)
          .filter((k) => k !== "convex" && k !== "deployment")
          .sort(),
        topic: event.topic,
        egressBytes: event.egress_bytes === counted,
        counted,
        verificationLeftOut: all !== counted,
      };
    }
    await Bun.sleep(100);
  }
  throw new Error(`${b.name}: no log_stream_egress event in 90 s`);
}

describe.skipIf(!ready)("log stream egress, on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await startAll([startConvex(), startBunvex()]);
  }, 120_000);
  afterAll(async () => {
    for (const s of stops) s();
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("one event after a minute: its fields, and the bytes sent before it without the connection test", async () => {
    const [c, b] = await Promise.all([observe(convex), observe(bunvex)]);
    const shape = ({ counted: _, ...rest }: Seen) => rest;
    expect(shape(c)).toEqual({
      keys: ["egress_bytes", "timestamp", "topic"],
      topic: "log_stream_egress",
      egressBytes: true,
      verificationLeftOut: true,
    });
    expect(shape(b)).toEqual(shape(c));
    expect(b.counted).toBeGreaterThan(0);
  }, 120_000);
});

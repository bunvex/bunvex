// Convex's CORS layer on the API (STUDY-67 H2, `router.rs` `cors()`): a page on another origin can call
// `/api/*`. Expected headers are what Convex's local backend answers (STUDY-67 §1.6).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, query } from "../src/functions.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", { ok: query(async () => "ok") });
  const http = httpRouter();
  http.route({ path: "/plain", method: "GET", handler: httpAction(async () => new Response("plain")) });
  const s = createServer({ engine, functions, port: 0, sitePort: null, http });
  stops.push(s.stop);
  return `http://127.0.0.1:${s.server!.port}`;
}

const ORIGIN = "https://app.example";
const VARY = "origin, access-control-request-method, access-control-request-headers";
const cors = (r: Response) => ({
  origin: r.headers.get("access-control-allow-origin"),
  credentials: r.headers.get("access-control-allow-credentials"),
  vary: r.headers.get("vary"),
});

test("a call from another origin: the origin mirrored, credentials allowed; none without an Origin", async () => {
  const base = await setup();
  const call = (headers: Record<string, string>) =>
    fetch(`${base}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ path: "m:ok", args: {} }),
    });
  const r = await call({ origin: ORIGIN });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ status: "success", value: "ok" });
  expect(cors(r)).toEqual({ origin: ORIGIN, credentials: "true", vary: VARY });
  expect(cors(await call({}))).toEqual({ origin: null, credentials: "true", vary: VARY });
});

test("a preflight: 200, no body, every method, a day's max age, the asked headers mirrored", async () => {
  const base = await setup();
  for (const path of ["/api/mutation", "/api/query_ts", "/api/storage/upload"]) {
    const r = await fetch(`${base}${path}`, {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
    expect(Object.fromEntries([...r.headers].filter(([k]) => k.startsWith("access-control-")))).toEqual({
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET,POST,OPTIONS,PATCH,DELETE,PUT",
      "access-control-allow-headers": "content-type,authorization",
      "access-control-max-age": "86400",
    });
  }
});

test("request errors carry the headers too, so a page can read them", async () => {
  const base = await setup();
  const r = await fetch(`${base}/api/query`, { method: "POST", headers: { origin: ORIGIN }, body: "{nope" });
  expect(r.status).toBe(400);
  expect(cors(r).origin).toBe(ORIGIN);
});

test("the health route has them; /version and HTTP actions do not (they answer CORS themselves)", async () => {
  const base = await setup();
  expect(cors(await fetch(`${base}/instance_name`, { headers: { origin: ORIGIN } })).origin).toBe(ORIGIN);
  expect(cors(await fetch(`${base}/version`, { headers: { origin: ORIGIN } })).origin).toBeNull();
  const action = await fetch(`${base}/http/plain`, { headers: { origin: ORIGIN } });
  expect(await action.text()).toBe("plain");
  expect(cors(action)).toEqual({ origin: null, credentials: null, vary: null });
});

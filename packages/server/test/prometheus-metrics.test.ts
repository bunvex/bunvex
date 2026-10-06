// `/metrics` (STUDY-114), as Convex's meta route: the Prometheus text exposition (0.0.4) of bunvex's series,
// open, on both ports, 404 `MetricsDisabled` with DISABLE_METRICS_ENDPOINT=true; what a mutation, a query
// subscription and an action record, the sync argument sizes, and cumulative histogram buckets.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { Registry } from "../src/prometheus.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";
import { metricsEndpointDisabled } from "../src/server-metrics.ts";
import { add, v1Client } from "./v1-client.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

// ---------------------------------------------------------------- a strict parser of the text format 0.0.4

type Series = { name: string; labels: Record<string, string>; value: number };
type Family = { type: string; help: string; series: Series[] };

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function parseValue(s: string): number {
  if (s === "+Inf") return Number.POSITIVE_INFINITY;
  if (s === "-Inf") return Number.NEGATIVE_INFINITY;
  if (s === "NaN") return Number.NaN;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) throw new Error(`bad value ${s}`);
  return Number(s);
}

/** Labels `{a="x",b="y"}` from position `i` of `line`: the labels and where they end. */
function parseLabels(line: string, i: number): [Record<string, string>, number] {
  const labels: Record<string, string> = {};
  i++; // {
  while (line[i] !== "}") {
    const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(line.slice(i));
    if (!m) throw new Error(`bad label name in ${line}`);
    const name = m[0];
    i += name.length;
    if (line.slice(i, i + 2) !== '="') throw new Error(`bad label in ${line}`);
    i += 2;
    let value = "";
    for (;;) {
      const c = line[i++];
      if (c === undefined) throw new Error(`unterminated label value in ${line}`);
      if (c === '"') break;
      if (c === "\\") {
        const e = line[i++];
        if (e === "n") value += "\n";
        else if (e === "\\" || e === '"') value += e;
        else throw new Error(`bad escape in ${line}`);
      } else value += c;
    }
    if (name in labels) throw new Error(`label ${name} twice in ${line}`);
    labels[name] = value;
    if (line[i] === ",") i++;
    else if (line[i] !== "}") throw new Error(`bad label separator in ${line}`);
  }
  return [labels, i + 1];
}

/** Parse an exposition, checking it as Prometheus's text parser does (and the histograms' invariants). */
function parseExposition(text: string): Map<string, Family> {
  if (!text.endsWith("\n")) throw new Error("the exposition must end with a newline");
  const families = new Map<string, Family>();
  const seen = new Set<string>();
  const familyOf = (sample: string) => {
    if (families.has(sample)) return families.get(sample)!;
    const base = sample.replace(/_(bucket|sum|count)$/, "");
    const f = families.get(base);
    if (f?.type === "histogram") return f;
    throw new Error(`sample ${sample} has no TYPE before it`);
  };
  for (const line of text.slice(0, -1).split("\n")) {
    if (line.startsWith("# HELP ") || line.startsWith("# TYPE ")) {
      const [, kind, name, ...rest] = line.split(" ");
      if (!NAME.test(name!)) throw new Error(`bad metric name ${name}`);
      const f = families.get(name!) ?? { type: "untyped", help: "", series: [] };
      if (kind === "HELP") f.help = rest.join(" ");
      else {
        if (f.series.length) throw new Error(`TYPE of ${name} after its samples`);
        if (!["counter", "gauge", "histogram", "summary", "untyped"].includes(rest[0]!))
          throw new Error(`bad type ${rest[0]}`);
        f.type = rest[0]!;
      }
      families.set(name!, f);
      continue;
    }
    if (line.startsWith("#") || line === "") continue;
    const m = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(line);
    if (!m) throw new Error(`bad sample line ${line}`);
    const name = m[0];
    let i = name.length;
    let labels: Record<string, string> = {};
    if (line[i] === "{") [labels, i] = parseLabels(line, i);
    if (line[i] !== " ") throw new Error(`no value in ${line}`);
    const parts = line.slice(i + 1).split(" ");
    if (parts.length > 2) throw new Error(`trailing text in ${line}`);
    const value = parseValue(parts[0]!);
    const key = `${name}${JSON.stringify(Object.entries(labels).sort())}`;
    if (seen.has(key)) throw new Error(`series ${key} twice`);
    seen.add(key);
    familyOf(name).series.push({ name, labels, value });
  }
  for (const [name, f] of families) {
    if (f.type === "counter") for (const s of f.series) expect(s.value).toBeGreaterThanOrEqual(0);
    if (f.type !== "histogram") continue;
    // Per label set (le aside): ascending `le`, cumulative counts, `+Inf` = `_count`.
    const groups = new Map<string, Series[]>();
    for (const s of f.series) {
      const { le, ...rest } = s.labels;
      const k = JSON.stringify(Object.entries(rest).sort());
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    for (const group of groups.values()) {
      const buckets = group.filter((s) => s.name === `${name}_bucket`);
      const count = group.find((s) => s.name === `${name}_count`);
      if (!count || !group.find((s) => s.name === `${name}_sum`)) throw new Error(`${name}: no _sum or _count`);
      if (buckets.at(-1)?.labels.le !== "+Inf") throw new Error(`${name}: no +Inf bucket last`);
      for (let j = 1; j < buckets.length; j++) {
        if (!(parseValue(buckets[j]!.labels.le!) > parseValue(buckets[j - 1]!.labels.le!)))
          throw new Error(`${name}: le not ascending`);
        if (buckets[j]!.value < buckets[j - 1]!.value) throw new Error(`${name}: buckets not cumulative`);
      }
      if (buckets.at(-1)!.value !== count.value) throw new Error(`${name}: +Inf bucket != _count`);
    }
  }
  return families;
}

/** One sample's value: the family's series whose labels include `labels`. */
function sample(families: Map<string, Family>, name: string, labels: Record<string, string> = {}): number {
  const base = name.replace(/_(bucket|sum|count)$/, "");
  const f = families.get(name) ?? families.get(base);
  const s = f?.series.find(
    (s) => s.name === name && Object.entries(labels).every(([k, value]) => s.labels[k] === value),
  );
  if (!s) throw new Error(`no sample ${name} ${JSON.stringify(labels)}`);
  return s.value;
}

// ---------------------------------------------------------------- the server

async function setup(opts: { disableMetricsEndpoint?: boolean } = {}) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    list: query(async ({ db }, _args: { tag: string }) => (await db.query("items").collect()).length),
    insert: mutation(async ({ db }, { text }: { text: string }) => {
      await db.insert("items", { text });
    }),
    fails: mutation(() => {
      throw new Error("no");
    }),
    act: action(async (_ctx, { blob }: { blob: string }) => blob.length),
  });
  const http = httpRouter();
  // An app route at `/metrics`: the site port's meta route answers first, as Convex's.
  http.route({ path: "/metrics", method: "GET", handler: httpAction(async () => new Response("the app's")) });
  const srv = createServer({ engine, functions, http, port: 0, ...opts });
  stops.push(srv.stop);
  const api = `http://127.0.0.1:${srv.server.port}`;
  const site = `http://127.0.0.1:${srv.site!.port}`;
  const scrape = async (origin = api) => {
    const r = await fetch(`${origin}/metrics`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    return parseExposition(await r.text());
  };
  const call = (kind: string, path: string, args: Record<string, unknown>) =>
    fetch(`${api}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args }),
    }).then((r) => r.json() as Promise<{ status: string }>);
  return { srv, engine, api, site, scrape, call };
}

test("the scrape parses as the text exposition format, with bunvex's series and no auth", async () => {
  const t = await setup();
  const m = await t.scrape();
  const names = [...m.keys()];
  expect(names.every((n) => n.startsWith("bunvex_"))).toBe(true);
  expect(names.length).toBeGreaterThanOrEqual(25);
  expect(m.get("bunvex_udf_execution_seconds")?.type).toBe("histogram");
  expect(m.get("bunvex_database_commits_total")?.type).toBe("counter");
  expect(m.get("bunvex_sync_sessions")?.type).toBe("gauge");
  // Every family has its HELP.
  for (const [name, f] of m) expect(`${name}: ${f.help}`).not.toBe(`${name}: `);
  const version = m.get("bunvex_version_info")!.series[0]!;
  expect(version.value).toBe(1);
  expect(version.labels.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(sample(m, "bunvex_process_resident_memory_bytes")).toBeGreaterThan(0);
  expect(sample(m, "bunvex_search_indexes", { kind: "text", state: "ready" })).toBe(0);
  // The site port serves the same, ahead of an app's HTTP action at `/metrics`.
  const s = await t.scrape(t.site);
  expect([...s.keys()]).toEqual(names);
  // A GET route: another method is refused.
  expect((await fetch(`${t.api}/metrics`, { method: "POST" })).status).toBe(405);
});

test("a mutation increments the function, commit and persistence series", async () => {
  const t = await setup();
  const before = await t.scrape();
  expect(await t.call("mutation", "m:insert", { text: "hello" })).toMatchObject({ status: "success" });
  expect(await t.call("mutation", "m:insert", { text: "again" })).toMatchObject({ status: "success" });
  expect(await t.call("mutation", "m:fails", {})).toMatchObject({ status: "error" });
  const after = await t.scrape();
  const delta = (name: string, labels: Record<string, string> = {}) =>
    sample(after, name, labels) - sample(before, name, labels);
  const mutation = { udf_type: "mutation" };
  expect(delta("bunvex_udf_executions_total", mutation)).toBe(3);
  expect(delta("bunvex_udf_errors_total", mutation)).toBe(1);
  expect(delta("bunvex_udf_execution_seconds_count", mutation)).toBe(3);
  expect(delta("bunvex_udf_executions_total", { udf_type: "query" })).toBe(0);
  // Two commits, each its own batch (the calls are sequential).
  expect(delta("bunvex_database_commits_total")).toBe(2);
  expect(delta("bunvex_database_write_batch_commits_count")).toBe(2);
  expect(delta("bunvex_database_write_batch_commits_sum")).toBe(2);
  expect(delta("bunvex_database_commit_persistence_write_seconds_count")).toBe(2);
  expect(sample(after, "bunvex_database_visible_ts_seconds")).toBeCloseTo(t.engine.committer.visibleTs / 1e6);
  expect(delta("bunvex_database_visible_ts_seconds")).toBeGreaterThan(0);
});

test("sync: sessions, subscriptions, invalidations and the arguments' bytes", async () => {
  const t = await setup();
  const c = await v1Client(`ws://127.0.0.1:${t.srv.server.port}/api/1.0.0/sync`);
  const queryArgs = { tag: "é".repeat(10) }; // multi-byte: bytes, not characters
  c.modify([add(1, "m:list", queryArgs), add(2, "m:list", { tag: "x" })]);
  await c.transition(0);
  c.mutate(1, "m:insert", { text: "abc" });
  await c.until(() => c.responses()[0]);
  await c.transition(1);
  const actionArgs = { blob: "z".repeat(5000) };
  c.send({ type: "Action", requestId: 2, udfPath: "m:act", args: [actionArgs] });
  await c.until(() => c.got.find((m) => m.type === "ActionResponse"));
  const m = await t.scrape();
  expect(sample(m, "bunvex_sync_sessions")).toBe(1);
  expect(sample(m, "bunvex_sync_subscriptions")).toBe(2);
  expect(sample(m, "bunvex_sync_subscription_invalidations_total")).toBeGreaterThanOrEqual(1);
  const bytes = (args: unknown) => Buffer.byteLength(JSON.stringify([args]));
  expect(sample(m, "bunvex_sync_query_modification_args_bytes_count")).toBe(1);
  expect(sample(m, "bunvex_sync_query_modification_args_bytes_sum")).toBe(bytes(queryArgs) + bytes({ tag: "x" }));
  expect(sample(m, "bunvex_sync_mutation_args_bytes_count")).toBe(1);
  expect(sample(m, "bunvex_sync_mutation_args_bytes_sum")).toBe(bytes({ text: "abc" }));
  expect(sample(m, "bunvex_sync_action_args_bytes_sum")).toBe(bytes(actionArgs));
  // 5 kB of arguments: above the 4096 bound, at or below 16384.
  expect(sample(m, "bunvex_sync_action_args_bytes_bucket", { le: "4096" })).toBe(0);
  expect(sample(m, "bunvex_sync_action_args_bytes_bucket", { le: "16384" })).toBe(1);
  // Two transitions, a mutation and an action response, at least.
  expect(sample(m, "bunvex_sync_transition_message_size_bytes_count")).toBeGreaterThanOrEqual(4);
  expect(sample(m, "bunvex_sync_transitions_total")).toBeGreaterThanOrEqual(2);
  expect(sample(m, "bunvex_udf_executions_total", { udf_type: "action" })).toBe(1);
  c.ws.close();
});

test("DISABLE_METRICS_ENDPOINT=true answers 404 MetricsDisabled, on both ports", async () => {
  const saved = process.env.DISABLE_METRICS_ENDPOINT;
  process.env.DISABLE_METRICS_ENDPOINT = "true";
  try {
    const t = await setup();
    for (const origin of [t.api, t.site]) {
      const r = await fetch(`${origin}/metrics`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ code: "MetricsDisabled", message: "/metrics endpoint disabled" });
    }
  } finally {
    if (saved === undefined) delete process.env.DISABLE_METRICS_ENDPOINT;
    else process.env.DISABLE_METRICS_ENDPOINT = saved;
  }
  // The option wins over the environment.
  const t = await setup({ disableMetricsEndpoint: true });
  expect((await fetch(`${t.api}/metrics`)).status).toBe(404);
});

test("the knob is a bool as Convex's: only `true` disables; another value is ignored", () => {
  expect(metricsEndpointDisabled(undefined)).toBe(false);
  expect(metricsEndpointDisabled("false")).toBe(false);
  expect(metricsEndpointDisabled("true")).toBe(true);
  const warn = console.warn;
  console.warn = () => {};
  try {
    expect(metricsEndpointDisabled("1")).toBe(false);
    expect(metricsEndpointDisabled("")).toBe(false);
  } finally {
    console.warn = warn;
  }
});

test("histogram buckets are cumulative, `le` inclusive, `+Inf` the count", () => {
  const r = new Registry();
  const h = r.histogram("x_seconds", "x", [1, 2, 5], ["k"]);
  for (const v of [0.5, 1, 1.5, 2, 3, 10, 10]) h.labels("a").observe(v);
  h.labels('q"\\\n').observe(1);
  const m = parseExposition(r.encode());
  const at = (le: string) => sample(m, "x_seconds_bucket", { k: "a", le });
  expect([at("1"), at("2"), at("5"), at("+Inf")]).toEqual([2, 4, 5, 7]);
  expect(sample(m, "x_seconds_count", { k: "a" })).toBe(7);
  expect(sample(m, "x_seconds_sum", { k: "a" })).toBe(28);
  // A label value with a quote, a backslash and a newline survives escaping.
  expect(sample(m, "x_seconds_count", { k: 'q"\\\n' })).toBe(1);
  expect(() => r.histogram("y", "y", [2, 1])).toThrow();
  expect(() => r.histogram("z", "z", [1], ["le"])).toThrow();
  expect(() => r.counter("x_seconds", "again")).toThrow();
});

test("the format's special values", () => {
  const r = new Registry();
  r.gauge(
    "g",
    "line one\nback\\slash",
    () => [
      [["inf"], Number.POSITIVE_INFINITY],
      [["ninf"], Number.NEGATIVE_INFINITY],
      [["nan"], Number.NaN],
    ],
    ["v"],
  );
  const text = r.encode();
  expect(text).toContain("# HELP g line one\\nback\\\\slash\n");
  expect(text).toContain('g{v="inf"} +Inf\n');
  expect(text).toContain('g{v="ninf"} -Inf\n');
  expect(text).toContain('g{v="nan"} NaN\n');
  parseExposition(text);
});

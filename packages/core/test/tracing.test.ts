// Traces (STUDY-131 AD-26): W3C trace context, the OpenTelemetry samplers, ids and times, and the spans the
// engine reports for a transaction's index reads (one per index, not per row) and for a commit.
import { describe, expect, test } from "bun:test";
import {
  CommitSpans,
  defineSchema,
  defineTable,
  Engine,
  IndexReadSpans,
  NO_TRACER,
  newSpanId,
  newTraceId,
  parseSampler,
  parseTraceparent,
  SPAN_KIND,
  type Span,
  sampled,
  Tracer,
  unixNanos,
} from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";

/** A sink that keeps what it is given. */
const collect = () => {
  const spans: Span[] = [];
  return { spans, sink: { add: (s: Span) => void spans.push(s) } };
};

describe("traceparent (W3C Trace Context §3.2)", () => {
  const tid = "4bf92f3577b34da6a3ce929d0e0e4736";
  const sid = "00f067aa0ba902b7";
  test("a valid header: ids and the sampled flag; tracestate kept", () => {
    expect(parseTraceparent(`00-${tid}-${sid}-01`, "k=v")).toEqual({
      traceId: tid,
      spanId: sid,
      sampled: true,
      traceState: "k=v",
    });
    expect(parseTraceparent(`00-${tid}-${sid}-00`)?.sampled).toBe(false);
    // Other flag bits do not matter; only bit 0 is "sampled".
    expect(parseTraceparent(`00-${tid}-${sid}-03`)?.sampled).toBe(true);
    expect(parseTraceparent(`00-${tid}-${sid}-02`)?.sampled).toBe(false);
  });
  test("invalid headers start a new trace", () => {
    for (const h of [
      null,
      "",
      `ff-${tid}-${sid}-01`, // version ff is invalid
      `00-${"0".repeat(32)}-${sid}-01`, // all-zero trace id
      `00-${tid}-${"0".repeat(16)}-01`, // all-zero span id
      `00-${tid.toUpperCase()}-${sid}-01`, // uppercase
      `00-${tid}-${sid}-01-extra`, // version 00 has exactly four fields
      `00-${tid.slice(1)}-${sid}-01`,
      `0-${tid}-${sid}-01`,
    ])
      expect(parseTraceparent(h)).toBeNull();
  });
  test("a later version is read by its first four fields", () => {
    expect(parseTraceparent(`01-${tid}-${sid}-01-whatever`)?.traceId).toBe(tid);
  });
});

describe("samplers (OTEL_TRACES_SAMPLER)", () => {
  const warnings: string[] = [];
  const warn = (m: string) => void warnings.push(m);
  test("names and their argument", () => {
    expect(parseSampler(undefined, undefined, warn)).toEqual({ root: "always_on", parentBased: true, ratio: 1 });
    expect(parseSampler("always_off", undefined, warn)).toEqual({ root: "always_off", parentBased: false, ratio: 1 });
    expect(parseSampler("parentbased_traceidratio", "0.1", warn)).toEqual({
      root: "traceidratio",
      parentBased: true,
      ratio: 0.1,
    });
    expect(parseSampler("TraceIdRatio", "0.25", warn)).toEqual({
      root: "traceidratio",
      parentBased: false,
      ratio: 0.25,
    });
    expect(warnings).toEqual([]);
    // Unknown or out of range: reported, and the default used.
    expect(parseSampler("jaeger_remote", undefined, warn)).toEqual({ root: "always_on", parentBased: true, ratio: 1 });
    expect(parseSampler("traceidratio", "2", warn).ratio).toBe(1);
    expect(warnings.length).toBe(2);
  });
  test("parent-based follows the caller's flag; a root decides from the trace id", () => {
    const parent = { traceId: newTraceId(), spanId: newSpanId(), sampled: false };
    expect(sampled({ root: "always_on", parentBased: true, ratio: 1 }, parent.traceId, parent)).toBe(false);
    expect(
      sampled({ root: "always_off", parentBased: true, ratio: 1 }, parent.traceId, { ...parent, sampled: true }),
    ).toBe(true);
    // Not parent-based: the root sampler decides even under a sampled parent.
    expect(
      sampled({ root: "always_off", parentBased: false, ratio: 1 }, parent.traceId, { ...parent, sampled: true }),
    ).toBe(false);
    const ratio = { root: "traceidratio" as const, parentBased: true, ratio: 0.5 };
    // The id's last 7 bytes against ratio × 2^56: deterministic.
    expect(sampled(ratio, `${"a".repeat(18)}00000000000000`, null)).toBe(true);
    expect(sampled(ratio, `${"a".repeat(18)}7ffffffffff000`, null)).toBe(true);
    expect(sampled(ratio, `${"a".repeat(18)}80000000000001`, null)).toBe(false);
    expect(sampled(ratio, `${"a".repeat(18)}ffffffffffffff`, null)).toBe(false);
    let n = 0;
    for (let i = 0; i < 10_000; i++) if (sampled({ ...ratio, ratio: 0.1 }, newTraceId(), null)) n++;
    expect(n).toBeGreaterThan(800);
    expect(n).toBeLessThan(1200);
  });
});

describe("ids and times", () => {
  test("ids are lowercase hex of 16 and 8 bytes, never all zero, distinct", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const t = newTraceId();
      const s = newSpanId();
      expect(t).toMatch(/^[0-9a-f]{32}$/);
      expect(s).toMatch(/^[0-9a-f]{16}$/);
      seen.add(t);
    }
    expect(seen.size).toBe(2000);
  });
  test("span times become Unix nanoseconds, as decimal strings", () => {
    const now = performance.now();
    const ns = BigInt(unixNanos(now));
    const wall = BigInt(Date.now()) * 1_000_000n;
    expect(ns > wall - 50_000_000n && ns < wall + 50_000_000n).toBe(true);
    // Sub-millisecond precision survives.
    expect(BigInt(unixNanos(now + 0.001)) - ns).toBe(1000n);
  });
});

describe("the tracer", () => {
  test("off: no span, and within() just runs", () => {
    expect(NO_TRACER.on).toBe(false);
    expect(NO_TRACER.root("x")).toBeNull();
    expect(NO_TRACER.child("x")).toBeNull();
    expect(NO_TRACER.within(null, () => 7)).toBe(7);
  });
  test("children of the current span; an unsampled root hides the caller's span", async () => {
    const { spans, sink } = collect();
    const t = new Tracer(sink);
    const root = t.root("root", SPAN_KIND.server)!;
    await t.within(root, async () => {
      await Bun.sleep(1);
      const c = t.child("child")!;
      expect(c.traceId).toBe(root.traceId);
      expect(c.parentSpanId).toBe(root.spanId);
      c.finish();
      // A root the sampler left out: nothing under it joins `root`'s trace.
      await t.within(null, async () => {
        await Bun.sleep(1);
        expect(t.child("orphan")).toBeNull();
      });
    });
    root.finish();
    root.finish(); // once
    expect(spans.map((s) => s.name)).toEqual(["child", "root"]);
  });
  test("a remote parent continues its trace", () => {
    const t = new Tracer(collect().sink);
    const p = { traceId: newTraceId(), spanId: newSpanId(), sampled: true, traceState: "a=b" };
    const r = t.root("r", SPAN_KIND.server, p)!;
    expect(r.traceId).toBe(p.traceId);
    expect(r.parentSpanId).toBe(p.spanId);
    expect(r.traceState).toBe("a=b");
    expect(t.root("r", SPAN_KIND.server, { ...p, sampled: false })).toBeNull();
  });
});

describe("engine spans", () => {
  const schema = defineSchema({
    messages: defineTable({ author: v.string(), body: v.string() }).index("by_author", ["author"]),
  });
  const open = async () => new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();

  test("index reads: one span per index, with its intervals and rows — never one per row", async () => {
    const engine = await open();
    await engine.mutation(async (db) => {
      for (let i = 0; i < 300; i++) await db.insert("messages", { author: i % 2 ? "ana" : "bob", body: `${i}` });
    });
    const { spans, sink } = collect();
    engine.tracer = new Tracer(sink);
    const root = engine.tracer.root("request")!;
    await engine.tracer.within(root, () =>
      engine.query(async (db) => {
        // 150 rows in one read, then again through a filter: pages of 64 and 128, two reads.
        await db
          .query("messages")
          .withIndex("by_author", (q) => q.eq("author", "ana"))
          .collect();
        await db
          .query("messages")
          .withIndex("by_author", (q) => q.eq("author", "ana"))
          .filter((q) => q.eq(q.field("body"), "none"))
          .collect();
        await db
          .query("messages")
          .withIndex("by_author", (q) => q.eq("author", "bob"))
          .take(3);
        const one = await db.query("messages").first();
        await db.get(one!._id);
      }),
    );
    root.finish();
    const byName = new Map(spans.map((s) => [s.name, s]));
    const ix = byName.get("index messages.by_author")!;
    expect(ix.parentSpanId).toBe(root.spanId);
    expect(ix.attributes).toMatchObject({ "bunvex.index": "messages.by_author", "bunvex.index.rows": 303 });
    expect(ix.attributes["bunvex.index.intervals"]).toBe(4);
    expect(ix.end).toBeGreaterThanOrEqual(ix.start);
    expect(byName.get("index messages.by_creation_time")?.attributes["bunvex.index.rows"]).toBe(1);
    expect(byName.get("index messages.by_id")?.attributes).toMatchObject({
      "bunvex.index.intervals": 1,
      "bunvex.index.rows": 1,
    });
    // Three index spans and the root: no span per row or per page.
    expect(spans.length).toBe(4);
  });

  test("untraced work (no current span) reports nothing", async () => {
    const engine = await open();
    const { spans, sink } = collect();
    engine.tracer = new Tracer(sink);
    await engine.mutation((db) => db.insert("messages", { author: "a", body: "b" }));
    await engine.query((db) => db.query("messages").collect());
    expect(spans).toEqual([]);
  });

  test("a commit: wait, validate and write under it, in the mutation's trace", async () => {
    const engine = await open();
    const { spans, sink } = collect();
    engine.tracer = new Tracer(sink);
    const root = engine.tracer.root("request")!;
    await engine.tracer.within(root, () =>
      engine.mutation(async (db) => {
        await db.insert("messages", { author: "a", body: "b" });
        await db.insert("messages", { author: "a", body: "c" });
      }),
    );
    const commit = spans.find((s) => s.name === "commit")!;
    expect(commit.parentSpanId).toBe(root.spanId);
    expect(commit.attributes["bunvex.commit.documents"]).toBe(2);
    expect(commit.attributes["bunvex.commit.ts"]).toBe(engine.committer.visibleTs);
    const under = spans.filter((s) => s.parentSpanId === commit.spanId);
    expect(under.map((s) => s.name).sort()).toEqual(["commit.validate", "commit.wait", "commit.write"]);
    for (const s of under) {
      expect(s.traceId).toBe(root.traceId);
      expect(s.start).toBeGreaterThanOrEqual(commit.start);
      expect(s.end).toBeLessThanOrEqual(commit.end);
    }
    const write = under.find((s) => s.name === "commit.write")!;
    expect(write.attributes).toMatchObject({ "bunvex.commit.batch_commits": 1, "bunvex.commit.batch_documents": 2 });
  });

  test("work a commit listener starts joins no request's trace", async () => {
    const engine = await open();
    const { spans, sink } = collect();
    engine.tracer = new Tracer(sink);
    // A listener that reads (as the scheduler's and the sync hub's start work on a commit). The committer
    // drains its group in the context of the commit that started it: without `detached`, this read would
    // be a child of that mutation's request.
    const listened: Promise<unknown>[] = [];
    engine.committer.onCommit(() => {
      listened.push(engine.query((db) => db.query("messages").first()));
    });
    const root = engine.tracer.root("request")!;
    await engine.tracer.within(root, () => engine.mutation((db) => db.insert("messages", { author: "a", body: "b" })));
    await Promise.all(listened);
    expect(listened.length).toBe(1);
    expect(spans.filter((s) => s.name.startsWith("index ")).map((s) => s.name)).toEqual([]);
  });

  test("a refused commit (a conflict) is a failed commit span", async () => {
    const { spans, sink } = collect();
    const root = new Tracer(sink).root("r")!;
    const c = new CommitSpans(root, 1, 2);
    c.validateStart = c.enqueued + 0.1;
    c.validateEnd = c.enqueued + 0.2;
    c.settle(null, new Error("conflict"));
    const commit = spans.find((s) => s.name === "commit")!;
    expect(commit.status).toBe(2);
    expect(commit.statusMessage).toBe("conflict");
    // Never written: no write span.
    expect(spans.map((s) => s.name).sort()).toEqual(["commit", "commit.validate", "commit.wait"]);
  });

  test("IndexReadSpans sums reads per index", () => {
    const { spans, sink } = collect();
    const root = new Tracer(sink).root("r")!;
    const r = new IndexReadSpans(root);
    const ix = { table: "t", name: "by_x" };
    r.record(ix, 3, performance.now());
    r.record(ix, 0, performance.now());
    r.record({ table: "t", name: "by_y" }, 1, performance.now());
    r.finish();
    expect(
      spans.map((s) => [s.name, s.attributes["bunvex.index.intervals"], s.attributes["bunvex.index.rows"]]),
    ).toEqual([
      ["index t.by_x", 2, 3],
      ["index t.by_y", 1, 1],
    ]);
  });
});

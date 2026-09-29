import { describe, expect, test } from "bun:test";
import { describeDataSourceContract } from "@bunvex/dashboard/contract";
import { DataSourceError, type LogEntry } from "@bunvex/dashboard/data-source";
import { createFixture, MockDataSource } from "@bunvex/dashboard/mock";

const NOW = Date.UTC(2026, 8, 29, 12);
const fast = { seed: 7, now: NOW, statsIntervalMs: 5, logIntervalMs: 5 };

describeDataSourceContract("MockDataSource", () => new MockDataSource(fast));
describeDataSourceContract("MockDataSource with latency", () => new MockDataSource({ ...fast, latencyMs: 2 }));

describe("MockDataSource", () => {
  test("the same seed and time give the same data; another seed does not", () => {
    expect(createFixture({ seed: 3, now: NOW })).toEqual(createFixture({ seed: 3, now: NOW }));
    expect(createFixture({ seed: 4, now: NOW }).tables[1]!.documents[0]).not.toEqual(
      createFixture({ seed: 3, now: NOW }).tables[1]!.documents[0],
    );
  });

  test("a cursor stays valid across inserts: no duplicate, no loss (it is a key, not an offset)", async () => {
    const src = new MockDataSource({ ...fast, documents: { tasks: 10 } });
    const p1 = await src.listDocuments({ table: "tasks", order: "asc", numItems: 4, cursor: null });
    const added = src.insertDocument("tasks", { text: "late", done: false });
    const rest = [];
    let cursor: string | null = p1.continueCursor;
    for (;;) {
      const p = await src.listDocuments({ table: "tasks", order: "asc", numItems: 4, cursor });
      rest.push(...p.page);
      if (p.isDone) break;
      cursor = p.continueCursor;
    }
    const ids = [...p1.page, ...rest].map((d) => d._id);
    expect(new Set(ids).size).toBe(11);
    expect(ids.at(-1)).toBe(added._id);
  });

  test("a finished walk's cursor picks up documents inserted later", async () => {
    const src = new MockDataSource({ ...fast, documents: { tasks: 3 } });
    const p = await src.listDocuments({ table: "tasks", order: "asc", numItems: 10, cursor: null });
    expect(p.isDone).toBe(true);
    const added = src.insertDocument("tasks", { text: "new" });
    const next = await src.listDocuments({ table: "tasks", order: "asc", numItems: 10, cursor: p.continueCursor });
    expect(next.page.map((d) => d._id)).toEqual([added._id]);
  });

  test("an abort during the simulated latency rejects at once", async () => {
    const src = new MockDataSource({ ...fast, latencyMs: 10_000 });
    const ac = new AbortController();
    const started = performance.now();
    const p = src.listTables({ signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    const e = await p.catch((err: unknown) => err);
    expect((e as Error).name).toBe("AbortError");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("failRate simulates an unavailable deployment", async () => {
    const e = await new MockDataSource({ ...fast, failRate: 1 }).getStats().catch((err: unknown) => err);
    expect(e).toBeInstanceOf(DataSourceError);
    expect((e as DataSourceError).code).toBe("unavailable");
  });

  test("returned data are copies: mutating them does not change the source", async () => {
    const src = new MockDataSource(fast);
    const [doc] = (await src.listDocuments({ table: "users", numItems: 1, cursor: null })).page;
    const copy = (await src.getDocument("users", doc!._id))!;
    copy.name = "changed";
    expect((await src.getDocument("users", doc!._id))!.name).not.toBe("changed");
  });

  test("watchLogs delivers new entries in id order, filtered, and they join the history", async () => {
    const src = new MockDataSource(fast);
    const got: LogEntry[] = [];
    const off = src.watchLogs(
      { levels: ["info"] },
      (e) => got.push(...e),
      () => {},
    );
    while (got.length < 5) await new Promise((r) => setTimeout(r, 5));
    off();
    const ids = got.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
    expect(got.every((e) => e.level === "info")).toBe(true);
    const newest = (await src.listLogs({ numItems: 200, cursor: null, levels: ["info"] })).page.map((e) => e.id);
    for (const id of ids) expect(newest).toContain(id);
  });

  test("watchStats counters only move forward", async () => {
    const src = new MockDataSource(fast);
    const seen: number[] = [];
    const off = src.watchStats(
      (s) => seen.push(s.commitTs),
      () => {},
    );
    while (seen.length < 4) await new Promise((r) => setTimeout(r, 5));
    off();
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)!).toBeGreaterThan(seen[0]!);
  });
});

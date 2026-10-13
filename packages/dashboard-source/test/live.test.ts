// `LiveGroup` with a fake sync connection: what a group follows, when its watchers hear about it, and Convex's
// auto-pause (`usePausedLiveData`: past 100 updates in a 10 s window).
import { describe, expect, test } from "bun:test";
import type { FunctionResult } from "@bunvex/client";
import type { LiveChange } from "@bunvex/dashboard/data-source";
import { fingerprint, LiveGroup, MAX_LISTS, PAUSE_THRESHOLD, PAUSE_WINDOW_MS, UpdateCounter } from "../src/live.ts";
import type { AdminSync } from "../src/sync.ts";

/** A sync connection whose query results the test sets; `subscribed` is what is subscribed now. */
class FakeSync {
  values = new Map<string, unknown>();
  listeners = new Map<string, Set<(r: FunctionResult) => void>>();
  key = (path: string, args: object) => JSON.stringify([path, args]);

  get subscribed(): string[] {
    return [...this.listeners.entries()].filter(([, s]) => s.size > 0).map(([k]) => k);
  }

  watch(path: string, args: object, onResult: (r: FunctionResult) => void) {
    const k = this.key(path, args);
    const set = this.listeners.get(k) ?? new Set();
    this.listeners.set(k, set.add(onResult));
    if (this.values.has(k))
      setTimeout(
        () => set.has(onResult) && onResult({ success: true, value: this.values.get(k) as never, logLines: [] }),
        0,
      );
    return () => set.delete(onResult);
  }

  async query<T>(path: string, args: object): Promise<T> {
    return this.values.get(this.key(path, args)) as T;
  }

  /** A new result for a query, delivered to its subscribers. */
  set(path: string, args: object, value: unknown) {
    const k = this.key(path, args);
    this.values.set(k, value);
    for (const l of this.listeners.get(k) ?? []) l({ success: true, value: value as never, logLines: [] });
  }
}

const tick = () => Bun.sleep(5);

function group(clock: () => number = Date.now) {
  const sync = new FakeSync();
  return { sync, live: new LiveGroup(sync as unknown as AdminSync, clock) };
}

const page = (ids: string[], cursor = "c1") => ({
  page: ids.map((_id) => ({ _id })),
  isDone: false,
  continueCursor: cursor,
});
const list = { list: "jobs", first: true, pausable: true };

describe("UpdateCounter (Convex's useRateLimitChanges)", () => {
  test("the 101st update in a window is the one that goes past", () => {
    let now = 0;
    const c = new UpdateCounter(() => now);
    for (let i = 0; i < PAUSE_THRESHOLD; i++) expect(c.hit()).toBe(false);
    now = PAUSE_WINDOW_MS; // the window is still open at exactly 10 s
    expect(c.hit()).toBe(true);
  });

  test("the first update after the window ends starts a new one", () => {
    let now = 0;
    const c = new UpdateCounter(() => now);
    for (let i = 0; i < PAUSE_THRESHOLD; i++) c.hit();
    now = PAUSE_WINDOW_MS + 1;
    for (let i = 0; i < PAUSE_THRESHOLD; i++) expect(c.hit()).toBe(false);
    expect(c.hit()).toBe(true);
  });
});

describe("fingerprint", () => {
  test("int64 and bytes are spelled out; a page's cursors are left out", () => {
    expect(fingerprint({ a: 1n })).not.toBe(fingerprint({ a: 2n }));
    expect(fingerprint(new Uint8Array([1]).buffer)).not.toBe(fingerprint(new Uint8Array([2]).buffer));
    expect(fingerprint(page(["a"], "x"))).toBe(fingerprint(page(["a"], "y")));
    expect(fingerprint({ continueCursor: "x" })).not.toBe(fingerprint({ continueCursor: "y" }));
  });
});

describe("LiveGroup", () => {
  test("a read is one-shot without a watcher; a watcher follows it and hears a new result", async () => {
    const { sync, live } = group();
    sync.set("q", { p: 1 }, page(["a"]));
    expect(await live.read<unknown>("q", { p: 1 }, list)).toEqual(page(["a"]));
    expect(sync.subscribed).toEqual([]);
    const heard: LiveChange[] = [];
    const off = live.watch(
      (c) => heard.push(c),
      () => {},
    );
    expect(sync.subscribed).toEqual([sync.key("q", { p: 1 })]);
    await tick();
    expect(heard).toEqual([]); // the first result is the one read
    sync.set("q", { p: 1 }, page(["a"], "other cursor"));
    expect(heard).toEqual([]); // same page
    sync.set("q", { p: 1 }, page(["a", "b"]));
    expect(heard).toEqual([{ paused: false }]);
    off();
    expect(sync.subscribed).toEqual([]);
  });

  test("a result that changed between the read and the watch is heard", async () => {
    const { sync, live } = group();
    sync.set("q", {}, 1);
    await live.read("q", {}, list);
    sync.set("q", {}, 2);
    const heard: LiveChange[] = [];
    live.watch(
      (c) => heard.push(c),
      () => {},
    );
    await tick();
    expect(heard).toEqual([{ paused: false }]);
  });

  test("a list's first page drops its other pages; other lists stay, up to MAX_LISTS", async () => {
    const { sync, live } = group();
    live.watch(
      () => {},
      () => {},
    );
    await live.read("q", { c: null }, list);
    await live.read("q", { c: "1" }, { ...list, first: false });
    await live.read("other", {}, { list: "other", first: true, pausable: false });
    expect(sync.subscribed.length).toBe(3);
    await live.read("q", { c: null }, list);
    expect(sync.subscribed).toEqual([sync.key("q", { c: null }), sync.key("other", {})]);
    for (let i = 0; i < MAX_LISTS; i++) await live.read("q", { f: i }, { ...list, list: `f${i}` });
    expect(sync.subscribed.length).toBe(MAX_LISTS);
    expect(sync.subscribed).not.toContain(sync.key("q", { c: null }));
  });

  test("past 100 updates in 10 s the paged lists pause; the rest stays live; a new watcher resumes", async () => {
    let now = 0;
    const { sync, live } = group(() => now);
    sync.set("jobs", {}, 0);
    sync.set("crons", {}, 0);
    const heard: LiveChange[] = [];
    live.watch(
      (c) => heard.push(c),
      () => {},
    );
    await live.read("jobs", {}, list);
    await live.read("crons", {}, { list: "crons", first: true, pausable: false });
    for (let i = 1; i <= PAUSE_THRESHOLD; i++) {
      now = i * 10;
      sync.set("jobs", {}, i);
    }
    expect(heard.length).toBe(PAUSE_THRESHOLD);
    expect(live.isPaused).toBe(false);
    sync.set("jobs", {}, -1);
    expect(heard.at(-1)).toEqual({ paused: true });
    expect(live.isPaused).toBe(true);
    expect(sync.subscribed).toEqual([sync.key("crons", {})]);
    const n = heard.length;
    sync.set("jobs", {}, -2);
    expect(heard.length).toBe(n);
    sync.set("crons", {}, 1);
    expect(heard.at(-1)).toEqual({ paused: true });
    // reads still answer while paused, without a subscription
    expect(await live.read<number>("jobs", {}, list)).toBe(-2);
    expect(sync.subscribed).toEqual([sync.key("crons", {})]);
    // "Go live"
    const again: LiveChange[] = [];
    live.watch(
      (c) => again.push(c),
      () => {},
    );
    expect(live.isPaused).toBe(false);
    expect(sync.subscribed.length).toBe(2);
    await tick();
    sync.set("jobs", {}, 7);
    expect(again).toEqual([{ paused: false }]);
  });

  test("updates spread over more than 10 s never pause", () => {
    let now = 0;
    const { sync, live } = group(() => now);
    sync.set("jobs", {}, 0);
    live.watch(
      () => {},
      () => {},
    );
    return live.read("jobs", {}, list).then(() => {
      for (let i = 1; i <= 3 * PAUSE_THRESHOLD; i++) {
        now = i * 101; // 100 updates take 10.1 s
        sync.set("jobs", {}, i);
      }
      expect(live.isPaused).toBe(false);
    });
  });

  test("a failed result is reported to the watchers", async () => {
    const { sync, live } = group();
    sync.set("q", {}, 1);
    const errors: string[] = [];
    live.watch(
      () => {},
      (e) => errors.push(e.code),
    );
    await live.read("q", {}, list);
    for (const l of sync.listeners.get(sync.key("q", {})) ?? [])
      l({ success: false, errorMessage: "boom", logLines: [] });
    expect(errors).toEqual(["unavailable"]);
  });
});

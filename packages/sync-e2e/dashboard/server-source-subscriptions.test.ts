// The dashboard's server source on the subscriptions inspector (STUDY-131 AD-25; STUDY-149's follow-up "AD-25 on a
// deployment") against a live bunvex server in this process: the contract suite's subscriptions area, then what it
// does not pin down — an app's live query listed with its read set, a mutation's invalidation followed and in the
// query's history, the query cache, and the log entry's "why it ran" link (AD-27) naming that same invalidation.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BunvexClient } from "@bunvex/client";
import { describeDataSourceContract } from "@bunvex/dashboard/contract";
import type { InvalidationEvent, LiveQuery, LogEntry } from "@bunvex/dashboard/data-source";
import { createServerDataSource, type ServerDataSource } from "@bunvex/dashboard-source";
import { type LiveServer, startLiveServer, until } from "./live-server.ts";

const INSTANCE = "dashboard-source-subscriptions";
let srv: LiveServer;
let app: BunvexClient;
let listed: string[] | undefined;
const sources: ServerDataSource[] = [];
const open = (adminKey = srv.adminKey) => {
  const s = createServerDataSource({ url: srv.url, adminKey, logs: { firstAnswerMs: 500 } });
  sources.push(s);
  return s;
};

beforeAll(async () => {
  srv = await startLiveServer(INSTANCE, [
    {
      path: "schema.js",
      source: `import { defineSchema, defineTable } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export default defineSchema({
          messages: defineTable({ author: v.string(), body: v.string() }).index("by_author", ["author"]),
        });`,
    },
    {
      path: "messages.js",
      source: `import { mutation, query } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export const byAuthor = query({ args: { author: v.string() }, handler: async ({ db }, { author }) =>
          (await db.query("messages").withIndex("by_author", (q) => q.eq("author", author)).collect())
            .map((m) => m.body) });
        export const send = mutation({ args: { author: v.string(), body: v.string() },
          handler: async ({ db }, m) => { await db.insert("messages", m); } });`,
    },
  ]);
  await srv.call("mutation", "messages:send", { author: "ana", body: "first" });
  // an app's live query, on its own connection
  app = new BunvexClient(srv.url, { logger: false });
  app.onUpdate("messages:byAuthor", { author: "ana" }, (v: string[]) => {
    listed = v;
  });
  await until(() => listed?.length === 1, "the app's first result");
});

afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
  await app?.close();
  srv?.stop();
});

describeDataSourceContract("@bunvex/dashboard-source on a live server (the subscriptions inspector)", () => open(), {
  only: ["subscriptions"],
});

/** The app's live query, as the inspector lists it. */
async function appQuery(src: ServerDataSource): Promise<LiveQuery> {
  const s = await src.getSubscriptions!({ path: "messages:byAuthor" });
  const q = s.sessions.filter((x) => x.identity === "none").flatMap((x) => x.queries)[0];
  if (!q) throw new Error("the app's query is not listed");
  return q;
}

describe("the subscriptions inspector on a live server", () => {
  test("an app's live query: its function, args digest, read set read back to values, why it first ran", async () => {
    const src = open();
    const q = await appQuery(src);
    expect(q.path).toBe("messages:byAuthor");
    expect(q.argsDigest).toMatch(/^[0-9a-f]{12}$/);
    expect(q.result).toBe("value");
    expect(q.cached).toBe(false);
    expect(q.documentsRead).toBe(1);
    const range = q.readSet.find((r) => r.index === "messages.by_author");
    expect(range?.fields).toEqual(["author", "_creationTime", "_id"]);
    expect(range?.lo).toEqual({ kind: "key", values: ["ana"], after: false, text: '["ana"]' });
    expect(range?.hi.kind).toBe("key");
    expect(q.history.at(-1)).toMatchObject({ kind: "rerun", reason: "newSubscriber" });
    // the filter is the server's: another function's path lists nothing of this one
    const other = await src.getSubscriptions!({ path: "nothing:here" });
    expect(other.totals.queries).toBe(0);
  });

  test("a mutation's invalidation is followed, is in the query's history, and the log's link names it", async () => {
    const src = open();
    const followed: InvalidationEvent[] = [];
    const errors: unknown[] = [];
    const lines: LogEntry[] = [];
    // the log tail first, so the re-run's line is new to it
    await src.listLogs({ numItems: 1, cursor: null });
    const offLogs = src.watchLogs(
      {},
      (e) => lines.push(...e),
      (e) => errors.push(e),
    );
    const off = src.watchInvalidations!(
      { path: "messages:" },
      (e) => followed.push(...e),
      (e) => errors.push(e),
    );
    // from now on: the feed's position is asked before anything is written
    await Bun.sleep(100);
    expect(followed).toEqual([]);
    await srv.call("mutation", "messages:send", { author: "ana", body: "second" });
    await until(() => listed?.length === 2, "the app's new result");
    const e = await until(() => followed.find((x) => x.path === "messages:byAuthor"), "the followed invalidation");
    expect(e).toMatchObject({
      kind: "invalidation",
      source: "messages:send",
      table: "messages",
      index: "messages.by_author",
    });
    expect(e.key.kind).toBe("key");
    expect((e.key as { values: unknown[] }).values[0]).toBe("ana");
    expect(e.commitTs).toBeGreaterThan(0);
    // a write outside the range invalidates nothing of it
    await srv.call("mutation", "messages:send", { author: "bo", body: "elsewhere" });
    await Bun.sleep(200);
    expect(followed.filter((x) => x.path === "messages:byAuthor")).toHaveLength(1);
    // the query's history has it, newest first, with the same seq
    const q = await appQuery(src);
    expect(q.argsDigest).toBe(e.argsDigest);
    expect(q.history[0]).toMatchObject({ kind: "invalidation", seq: e.seq, commitTs: e.commitTs });
    const sent = await until(async () => {
      const h = (await appQuery(src)).history[0];
      return h?.kind === "invalidation" && h.sentAfterMs !== null && h;
    }, "the delay until sent");
    expect(sent.sentAfterMs).toBeGreaterThanOrEqual(0);
    // the re-run's log entry links to exactly this query and invalidation (AD-27's "Open the invalidation")
    const rerun = await until(
      () =>
        lines.find((l) => l.function?.path === "messages:byAuthor" && l.execution?.links?.subscription?.invalidation),
      "the re-run's log entry",
    );
    expect(rerun.execution?.links?.subscription).toEqual({
      argsDigest: e.argsDigest,
      reason: "invalidation",
      invalidation: { seq: e.seq, commitTs: e.commitTs },
    });
    off();
    offLogs();
    expect(errors).toEqual([]);
  });

  test("the query cache: an HTTP query's entry with its read set, the counters", async () => {
    const src = open();
    await srv.call("query", "messages:byAuthor", { author: "ana" });
    await srv.call("query", "messages:byAuthor", { author: "ana" });
    const c = await src.getQueryCache!({ path: "messages:byAuthor", limit: 5 });
    expect(c.matching).toBeGreaterThanOrEqual(1);
    const entry = c.biggest[0]!;
    expect(entry).toMatchObject({ path: "messages:byAuthor", state: "ready", shared: true });
    expect(entry.readSet?.some((r) => r.index === "messages.by_author")).toBe(true);
    expect(c.hits).toBeGreaterThanOrEqual(1);
    expect(Object.keys(c.missReasons).sort()).toEqual(["evicted", "expired", "invalidated", "new", "snapshot"]);
  });

  test("closing the source stops its follow loop", async () => {
    const src = createServerDataSource({ url: srv.url, adminKey: srv.adminKey });
    const followed: InvalidationEvent[] = [];
    src.watchInvalidations!(
      {},
      (e) => followed.push(...e),
      () => {},
    );
    await Bun.sleep(100);
    await src.close();
    await srv.call("mutation", "messages:send", { author: "ana", body: "after the close" });
    await Bun.sleep(200);
    expect(followed).toEqual([]);
  });
});

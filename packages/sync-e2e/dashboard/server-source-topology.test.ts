// The topology (STUDY-131 §11, AD-04) on a live bunvex server: the contract's topology area, then what it does not
// pin down — the deployment's one node and its store as the server reports them, and a client that connects and
// subscribes showing on the node through `watchTopology`, then leaving it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BunvexClient } from "@bunvex/client";
import { describeDataSourceContract } from "@bunvex/dashboard/contract";
import type { Topology } from "@bunvex/dashboard/data-source";
import { createServerDataSource, type ServerDataSource } from "@bunvex/dashboard-source";
import { type LiveServer, startLiveServer, until } from "./live-server.ts";

const INSTANCE = "dashboard-topology";
let srv: LiveServer;
const sources: ServerDataSource[] = [];
const open = (adminKey = srv.adminKey) => {
  const s = createServerDataSource({ url: srv.url, adminKey, topologyIntervalMs: 50 });
  sources.push(s);
  return s;
};

beforeAll(async () => {
  srv = await startLiveServer(INSTANCE, [
    {
      path: "schema.js",
      source: `import { defineSchema, defineTable } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export default defineSchema({ notes: defineTable({ body: v.string() }) });`,
    },
    {
      path: "notes.js",
      source: `import { mutation, query } from "@bunvex/server";
        export const list = query(async ({ db }) => db.query("notes").collect());
        export const add = mutation(async ({ db }, { body }) => db.insert("notes", { body }));`,
    },
  ]);
});

afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
  srv.stop();
});

describeDataSourceContract("@bunvex/dashboard-source on a live server (topology)", () => open(), {
  only: ["topology"],
});

describe("the deployment's topology", () => {
  test("one node, the leader alone, on a memory store behind a file lock", async () => {
    const t = await open().getTopology!();
    expect(t.nodes).toHaveLength(1);
    const [n] = t.nodes;
    expect(n).toMatchObject({ role: "leader", state: "ok", scheduler: true, memoryLimitBytes: null });
    expect(n!.version).toBe(await (await fetch(`${srv.url}/version`)).text());
    expect(n!.cache?.maxBytes).toBeGreaterThan(0);
    expect(n!.cache?.maxEntries).toBeUndefined();
    expect(t.store).toMatchObject({ driver: "memory", singleNode: true, leaseHolder: n!.id, latencyMs: null });
    expect(t.events).toEqual([]);
  });

  test("a client that connects and subscribes shows on the node, live, and leaves it again", async () => {
    const src = open();
    let latest: Topology | undefined;
    const off = src.watchTopology!(
      (t) => {
        latest = t;
      },
      (e) => {
        throw e;
      },
    );
    try {
      const base = await until(() => latest?.nodes[0], "a first picture");
      const app = new BunvexClient(srv.url, { logger: false });
      const unsubscribe = app.onUpdate("notes:list", {}, () => {});
      try {
        const on = await until(
          () => latest && latest.nodes[0]!.subscriptions > base.subscriptions && latest.nodes[0],
          "the client on the node",
        );
        expect(on.connections).toBe(base.connections + 1);
        await srv.call("mutation", "notes:add", { body: "hi" });
      } finally {
        unsubscribe();
        await app.close();
      }
      await until(() => latest && latest.nodes[0]!.connections === base.connections, "the client gone");
    } finally {
      off();
    }
  });

  test("a read-only key may look (ViewMetrics)", async () => {
    expect((await open(srv.readOnlyKey).getTopology!()).nodes).toHaveLength(1);
  });
});

// The topology (STUDY-131 §11, AD-04): `/api/debug/topology` read as the contract's `Topology`, and polled by
// `watchTopology` — never synchronously, one request at a time, stopped by its unsubscribe.
import { describe, expect, test } from "bun:test";
import type { DataSourceError, Topology } from "@bunvex/dashboard/data-source";
import { AdminHttp } from "../src/admin-http.ts";
import { TOPOLOGY_INTERVAL_MS, topologyReads } from "../src/topology.ts";

/** What a single-node deployment answers (`packages/server/src/topology.ts`), with fields the contract lacks. */
const answer = () => ({
  time: 1_700_000_000_000,
  nodes: [
    {
      id: "host:1:ab",
      role: "leader",
      state: "ok",
      version: "0.9.0",
      startedAt: 1_699_999_000_000,
      cpu: 0.02,
      memoryBytes: 1_000_000,
      memoryLimitBytes: null,
      connections: 2,
      subscriptions: 3,
      cache: { entries: 4, bytes: 4096, maxBytes: 104_857_600, hitRate: 0.75, invalidationsPerSecond: 1, evictions: 0 },
      commitsPerSecond: 2.5,
      scheduler: true,
      actionsRunning: 1,
      history: [
        {
          time: 1_699_999_995_000,
          cpu: 0.02,
          lagMs: null,
          connections: 2,
          cacheHitRate: null,
          invalidationsPerSecond: 0,
          extra: 1,
        },
      ],
      somethingNew: true,
    },
  ],
  store: {
    driver: "sqlite",
    singleNode: true,
    leaseHolder: "host:1:ab",
    leaseExpiresAt: null,
    leaseTtlMs: null,
    latencyMs: null,
    sizeBytes: null,
    connections: null,
  },
  events: [],
});

function answering(respond: (n: number) => Response | Promise<Response>) {
  const asked: Request[] = [];
  const http = new AdminHttp({
    url: "http://x",
    adminKey: "k",
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(new Request(String(input), init));
      return Promise.resolve(respond(asked.length));
    }) as typeof fetch,
  });
  return { http, asked };
}

describe("getTopology", () => {
  test("the route with the admin key; the contract's fields only, the cache bounded by bytes", async () => {
    const { http, asked } = answering(() => Response.json(answer()));
    const t = await topologyReads(http).getTopology();
    expect(new URL(asked[0]!.url).pathname).toBe("/api/debug/topology");
    expect(asked[0]!.headers.get("authorization")).toBe("Bunvex k");
    const n = t.nodes[0]!;
    expect("somethingNew" in n).toBe(false);
    expect(n.cache).toEqual({
      entries: 4,
      bytes: 4096,
      maxBytes: 104_857_600,
      hitRate: 0.75,
      invalidationsPerSecond: 1,
      evictions: 0,
    });
    expect(n.history).toEqual([
      {
        time: 1_699_999_995_000,
        cpu: 0.02,
        lagMs: null,
        connections: 2,
        cacheHitRate: null,
        invalidationsPerSecond: 0,
      },
    ]);
    expect(n.lag).toBeUndefined();
    expect(t.store.driver).toBe("sqlite");
    expect(t.events).toEqual([]);
  });

  test("a driver the dashboard cannot name is `other`; no picture, or a refusal, is an error", async () => {
    const other = answer();
    other.store.driver = "foundationdb";
    expect((await topologyReads(answering(() => Response.json(other)).http).getTopology()).store.driver).toBe("other");
    const none = { ...answer(), nodes: [] };
    await expect(topologyReads(answering(() => Response.json(none)).http).getTopology()).rejects.toMatchObject({
      code: "unavailable",
    });
    const refused = answering(() => Response.json({ code: "BadAdminKey", message: "no" }, { status: 403 }));
    await expect(topologyReads(refused.http).getTopology()).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("watchTopology", () => {
  test("never synchronously; polled one request at a time; an error told and the polling kept; stopped by off", async () => {
    let release: (() => void) | undefined;
    const { http, asked } = answering(async (n) => {
      if (n === 2) return Response.json({ code: "Boom", message: "down" }, { status: 503 });
      if (n === 3) await new Promise<void>((r) => (release = r));
      return Response.json(answer());
    });
    const got: Topology[] = [];
    const errors: DataSourceError[] = [];
    const off = topologyReads(http, { topologyIntervalMs: 20 }).watchTopology(
      (t) => got.push(t),
      (e) => errors.push(e),
    );
    expect(got.length + asked.length).toBe(0);
    await Bun.sleep(5);
    expect(got).toHaveLength(1);
    await Bun.sleep(30);
    expect(errors.map((e) => e.code)).toEqual(["unavailable"]);
    // the third request hangs: no fourth is sent meanwhile
    await Bun.sleep(80);
    expect(asked).toHaveLength(3);
    release!();
    await Bun.sleep(5);
    expect(got).toHaveLength(2);
    off();
    const sent = asked.length;
    await Bun.sleep(60);
    expect(asked.length).toBe(sent);
    expect(got).toHaveLength(2);
  });

  test("unsubscribed while a request is out: its answer is dropped and no other request follows", async () => {
    let release: (() => void) | undefined;
    const { http, asked } = answering(async () => {
      await new Promise<void>((r) => (release = r));
      return Response.json(answer());
    });
    const got: Topology[] = [];
    const errors: DataSourceError[] = [];
    const off = topologyReads(http, { topologyIntervalMs: 10 }).watchTopology(
      (t) => got.push(t),
      (e) => errors.push(e),
    );
    await Bun.sleep(5);
    expect(asked).toHaveLength(1);
    off();
    release!();
    await Bun.sleep(50);
    expect(got).toEqual([]);
    expect(errors).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  test("the default cadence is the server's sampling period", () => {
    expect(TOPOLOGY_INTERVAL_MS).toBe(5_000);
  });
});

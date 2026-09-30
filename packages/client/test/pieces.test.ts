// The client's pieces on their own, with a fake socket (STUDY-26 §5), as Convex's client unit tests.
import { describe, expect, test } from "bun:test";
import { anyApi, getFunctionName, makeFunctionReference, v1 } from "@bunvex/protocol";
import { BaseBunvexClient } from "../src/base-client.ts";
import { LocalSyncState } from "../src/local-state.ts";
import { instantiateNoopLogger } from "../src/logging.ts";
import { OptimisticQueryResults } from "../src/optimistic-updates.ts";
import { RemoteQuerySet } from "../src/remote-query-set.ts";
import { RequestManager } from "../src/request-manager.ts";
import { canonicalizeUdfPath, serializePathAndArgs } from "../src/udf-path.ts";

const logger = instantiateNoopLogger({ verbose: false });
const version = (querySet: number, ts: bigint, identity = 0): v1.StateVersion => ({ querySet, ts, identity });
const transition = (start: v1.StateVersion, end: v1.StateVersion, modifications: v1.StateModification[] = []) =>
  ({ type: "Transition", startVersion: start, endVersion: end, modifications }) as v1.Transition;

/** A WebSocket stand-in the test drives: `sent` holds what the client sent; `receive` delivers a frame. */
class FakeSocket {
  static last: FakeSocket;
  sent: v1.ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(frame: string) {
    this.sent.push(v1.parseClientMessage(frame));
  }
  close() {
    this.onclose?.({ code: 1000, reason: "" });
  }
  open() {
    this.onopen?.();
  }
  receive(m: v1.ServerMessage) {
    this.onmessage?.({ data: v1.encodeServerMessage(m) });
  }
}

describe("function references and paths", () => {
  test("anyApi names functions as Convex does", () => {
    expect(getFunctionName(anyApi.messages.list)).toBe("messages:list");
    expect(getFunctionName(anyApi.dir.file.fn)).toBe("dir/file:fn");
    expect(getFunctionName(anyApi.dir.file.default)).toBe("dir/file");
    expect(getFunctionName(makeFunctionReference<"query">("a:b"))).toBe("a:b");
    expect(getFunctionName("plain:name")).toBe("plain:name");
    expect(() => getFunctionName(anyApi.messages)).toThrow("api.moduleName.functionName");
  });

  test("paths are canonical and tokens encode values", () => {
    expect(canonicalizeUdfPath("m.js:f")).toBe("m:f");
    expect(canonicalizeUdfPath("dir/m")).toBe("dir/m:default");
    expect(serializePathAndArgs("m.js:f", { n: 1n }) as string).toBe(
      '{"udfPath":"m:f","args":{"n":{"$integer":"AQAAAAAAAAA="}}}',
    );
  });
});

describe("RemoteQuerySet", () => {
  test("transitions must chain; results by query id", () => {
    const r = new RemoteQuerySet(() => "m:q", logger);
    r.transition(
      transition(version(0, 0n), version(1, 5n), [
        { type: "QueryUpdated", queryId: 0, value: { $integer: "AQAAAAAAAAA=" }, logLines: [], journal: null },
      ]),
    );
    expect(r.remoteQueryResults().get(0)).toEqual({ success: true, value: 1n, logLines: [] });
    expect(r.timestamp()).toBe(5n);
    expect(() => r.transition(transition(version(0, 0n), version(1, 6n)))).toThrow("Invalid start version: 0:0:0");
  });
});

describe("RequestManager", () => {
  const mutation = (requestId: number): v1.MutationRequest => ({
    type: "Mutation",
    requestId,
    udfPath: "m:x",
    args: [{}],
  });

  test("a mutation resolves only once a transition reaches its ts; a failure at once", async () => {
    const rm = new RequestManager(logger, () => {});
    let done = false;
    const p = rm.request(mutation(0), true).then((r) => {
      done = true;
      return r;
    });
    rm.onResponse({ type: "MutationResponse", requestId: 0, success: true, result: 1, ts: 10n, logLines: [] });
    await Bun.sleep(0);
    expect(done).toBe(false);
    expect(rm.removeCompleted(9n).size).toBe(0);
    expect(rm.removeCompleted(10n).size).toBe(1);
    expect(await p).toEqual({ success: true, value: 1, logLines: [] });
    const f = rm.request(mutation(1), true);
    rm.onResponse({ type: "MutationResponse", requestId: 1, success: false, result: "boom", logLines: [] });
    expect(await f).toEqual({ success: false, errorMessage: "boom", logLines: [] });
  });

  test("restart re-sends every unreflected mutation, completed ones too, and fails actions", async () => {
    const rm = new RequestManager(logger, () => {});
    void rm.request(mutation(0), true);
    rm.onResponse({ type: "MutationResponse", requestId: 0, success: true, result: null, ts: 10n, logLines: [] });
    void rm.request(mutation(1), false);
    const action = rm.request({ type: "Action", requestId: 2, udfPath: "m:a", args: [{}] }, true);
    const resent = rm.restart();
    expect(resent.map((m) => (m as v1.MutationRequest).requestId)).toEqual([0, 1]);
    expect(await action).toEqual({
      success: false,
      errorMessage: "Connection lost while action was in flight",
      logLines: [],
    });
    expect(rm.hasSyncedPastLastReconnect()).toBe(false);
    rm.removeCompleted(10n);
    rm.onResponse({ type: "MutationResponse", requestId: 1, success: false, result: "x", logLines: [] });
    expect(rm.hasSyncedPastLastReconnect()).toBe(true);
  });
});

describe("LocalSyncState", () => {
  test("shared subscriptions, versions, and a restart that re-sends the set with journals", () => {
    const s = new LocalSyncState();
    const a = s.subscribe("m:q", { x: 1 });
    const b = s.subscribe("m:q", { x: 1 });
    expect(a.modification).toMatchObject({ baseVersion: 0, newVersion: 1 });
    expect(b.modification).toBeNull();
    s.subscribe("m:r", {});
    s.transition(
      transition(version(0, 0n), version(2, 1n), [
        { type: "QueryUpdated", queryId: 0, value: 1, logLines: [], journal: "j0" },
      ]),
    );
    expect(b.unsubscribe()).toBeNull(); // one subscriber left
    const [querySet, auth] = s.restart();
    expect(auth).toBeUndefined();
    expect(querySet).toEqual({
      type: "ModifyQuerySet",
      baseVersion: 0,
      newVersion: 1,
      modifications: [
        { type: "Add", queryId: 0, udfPath: "m:q", args: [{ x: 1 }], journal: "j0" },
        { type: "Add", queryId: 1, udfPath: "m:r", args: [{}] },
      ],
    });
    expect(s.hasSyncedPastLastReconnect()).toBe(false);
    expect(a.unsubscribe()).toMatchObject({
      baseVersion: 1,
      newVersion: 2,
      modifications: [{ type: "Remove", queryId: 0 }],
    });
  });
});

describe("OptimisticQueryResults", () => {
  test("updates apply at once, re-apply over new server results, and drop when their mutation is reflected", () => {
    const o = new OptimisticQueryResults();
    const token = serializePathAndArgs("m:list", {});
    const server = (value: string[]) =>
      new Map([[token, { udfPath: "m:list", args: {}, result: { success: true as const, value, logLines: [] } }]]);
    o.ingestQueryResultsFromServer(server([]), new Set());
    const add = (store: Parameters<Parameters<OptimisticQueryResults["applyOptimisticUpdate"]>[0]>[0]) => {
      const cur = (store.getQuery(anyApi.m.list, {}) as string[]) ?? [];
      store.setQuery(anyApi.m.list, {}, [...cur, "guess"]);
    };
    expect(o.applyOptimisticUpdate(add, 7)).toEqual([token]);
    expect(o.queryResult(token)).toEqual(["guess"]);
    o.ingestQueryResultsFromServer(server(["other"]), new Set());
    expect(o.queryResult(token)).toEqual(["other", "guess"]);
    o.ingestQueryResultsFromServer(server(["other", "real"]), new Set([7]));
    expect(o.queryResult(token)).toEqual(["other", "real"]);
  });
});

describe("BaseBunvexClient over a fake socket", () => {
  const make = () =>
    new BaseBunvexClient("http://example.test", () => {}, {
      logger: false,
      webSocketConstructor: FakeSocket as unknown as typeof WebSocket,
      unsavedChangesWarning: false,
      webSocket: { defaultInitialBackoffMs: 1, maxBackoffMs: 4 },
    });

  test("connects to /api/<version>/sync and sends Connect, then the query set", () => {
    const c = make();
    c.subscribe("m:q", {});
    const ws = FakeSocket.last;
    expect(ws.url).toBe("ws://example.test/api/0.0.0/sync");
    ws.open();
    expect(ws.sent.map((m) => m.type)).toEqual(["Connect", "ModifyQuerySet"]);
    expect(ws.sent[0]).toMatchObject({
      type: "Connect",
      sessionId: c.sessionId,
      connectionCount: 0,
      lastCloseReason: "InitialConnect",
    });
    void c.close();
  });

  test("a FatalError terminates the client", () => {
    const c = make();
    const ws = FakeSocket.last;
    ws.open();
    expect(() => ws.receive({ type: "FatalError", error: "bad" })).toThrow("[BUNVEX FATAL ERROR] bad");
    expect(c.connectionState().isWebSocketConnected).toBe(false);
  });

  test("after a close it reconnects, with the session and the max observed ts", async () => {
    const c = make();
    const first = FakeSocket.last;
    first.open();
    first.receive({ type: "Transition", startVersion: version(0, 0n), endVersion: version(1, 42n), modifications: [] });
    first.onclose?.({ code: 1006, reason: "" });
    await Bun.sleep(20);
    const second = FakeSocket.last;
    expect(second).not.toBe(first);
    second.open();
    expect(second.sent[0]).toMatchObject({
      type: "Connect",
      sessionId: c.sessionId,
      connectionCount: 1,
      lastCloseReason: "closed with code 1006",
      maxObservedTimestamp: 42n,
    });
    void c.close();
  });
});

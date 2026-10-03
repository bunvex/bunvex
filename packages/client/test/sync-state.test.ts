// The client's bookkeeping between sockets, as Convex's client unit tests check it (STUDY-65 G-C8, G-C24,
// G-C25, G-C26; Convex's react/auth_websocket.test.tsx pause cases, browser/sync/local_state.test.ts,
// optimistic_query_set.test.ts and request_manager.test.ts). A wrong query set after a pause is a base
// version mismatch, which the server answers with a fatal error.
import { describe, expect, test } from "bun:test";
import { anyApi, type v1 } from "@bunvex/protocol";
import { LocalSyncState } from "../src/local-state.ts";
import { instantiateNoopLogger } from "../src/logging.ts";
import { OptimisticQueryResults } from "../src/optimistic-updates.ts";
import { RequestManager } from "../src/request-manager.ts";
import { serializePathAndArgs } from "../src/udf-path.ts";

const logger = instantiateNoopLogger({ verbose: false });
const answered = (...queryIds: number[]): v1.Transition => ({
  type: "Transition",
  startVersion: { querySet: 0, ts: 0n, identity: 0 },
  endVersion: { querySet: 1, ts: 1n, identity: 0 },
  modifications: queryIds.map((queryId) => ({
    type: "QueryUpdated" as const,
    queryId,
    value: null,
    logLines: [],
    journal: null,
  })),
});

describe("LocalSyncState: the query set across a pause (auth)", () => {
  test("an Add sent before the pause is not sent again on resume", () => {
    const s = new LocalSyncState();
    expect(s.subscribe("m:a", {}).modification).toMatchObject({ baseVersion: 0, newVersion: 1 });
    s.pause();
    expect(s.resume()).toEqual([undefined, undefined]);
    // The next change builds on the version the server has.
    expect(s.subscribe("m:b", {}).modification).toMatchObject({ baseVersion: 1, newVersion: 2 });
  });

  test("an Add and a Remove of one query while paused cancel out", () => {
    const s = new LocalSyncState();
    s.subscribe("m:a", {});
    s.pause();
    const b = s.subscribe("m:b", {});
    b.unsubscribe();
    expect(s.resume()).toEqual([undefined, undefined]);
    expect(s.subscribe("m:c", {}).modification).toMatchObject({ baseVersion: 1, newVersion: 2 });
  });

  test("subscribers are counted while paused: two subscribes and one unsubscribe are one Add", () => {
    const s = new LocalSyncState();
    s.pause();
    const first = s.subscribe("m:a", { x: 1 });
    s.subscribe("m:a", { x: 1 });
    first.unsubscribe();
    const [querySet] = s.resume();
    expect(querySet).toEqual({
      type: "ModifyQuerySet",
      baseVersion: 0,
      newVersion: 1,
      modifications: [{ type: "Add", queryId: 0, udfPath: "m:a", args: [{ x: 1 }] }],
    });
  });

  test("a Remove made while paused waits for resume, then later changes build on it", () => {
    const s = new LocalSyncState();
    const a = s.subscribe("m:a", {});
    s.setAuth("token-1");
    s.pause();
    a.unsubscribe();
    const [querySet, auth] = s.resume();
    expect(querySet).toEqual({
      type: "ModifyQuerySet",
      baseVersion: 1,
      newVersion: 2,
      modifications: [{ type: "Remove", queryId: 0 }],
    });
    expect(auth).toEqual({ type: "Authenticate", baseVersion: 1, tokenType: "User", value: "token-1" });
    expect(s.subscribe("m:b", {}).modification).toMatchObject({ baseVersion: 2, newVersion: 3 });
  });

  test("a restart while subscribing and unsubscribing sends only what is still subscribed", () => {
    const s = new LocalSyncState();
    s.pause();
    s.subscribe("m:gone", {}).unsubscribe();
    const [querySet, auth] = s.restart();
    expect(querySet).toEqual({ type: "ModifyQuerySet", baseVersion: 0, newVersion: 1, modifications: [] });
    expect(auth).toBeUndefined();
  });
});

describe("LocalSyncState: synced past the last reconnect only when everything re-sent is answered", () => {
  test("every re-sent query must be answered, not some", () => {
    const s = new LocalSyncState();
    s.subscribe("m:a", {});
    s.subscribe("m:b", {});
    s.restart();
    expect(s.hasSyncedPastLastReconnect()).toBe(false);
    s.transition(answered(0));
    expect(s.hasSyncedPastLastReconnect()).toBe(false);
    s.transition(answered(1));
    expect(s.hasSyncedPastLastReconnect()).toBe(true);
  });

  test("unsubscribing the query still outstanding counts as synced", () => {
    const s = new LocalSyncState();
    const a = s.subscribe("m:a", {});
    s.restart();
    a.unsubscribe();
    expect(s.hasSyncedPastLastReconnect()).toBe(true);
  });

  test("with a token, the auth must be confirmed too; clearing it also counts", () => {
    const s = new LocalSyncState();
    s.subscribe("m:a", {});
    s.setAuth("token-1");
    s.restart();
    s.transition(answered(0));
    expect(s.hasSyncedPastLastReconnect()).toBe(false);
    s.markAuthCompletion();
    expect(s.hasSyncedPastLastReconnect()).toBe(true);
    s.restart();
    s.transition(answered(0));
    expect(s.hasSyncedPastLastReconnect()).toBe(false);
    s.clearAuth();
    expect(s.hasSyncedPastLastReconnect()).toBe(true);
  });
});

describe("OptimisticQueryResults: stacked updates", () => {
  const token = (name: string) => serializePathAndArgs(name, {});
  const result = (value: unknown) => ({ success: true as const, value: value as never, logLines: [] });
  const server = (entries: Record<string, unknown>) =>
    new Map(Object.entries(entries).map(([n, v]) => [token(n), { udfPath: n, args: {}, result: result(v) }]));
  type Store = Parameters<Parameters<OptimisticQueryResults["applyOptimisticUpdate"]>[0]>[0];
  const append = (tag: string) => (store: Store) =>
    store.setQuery(anyApi.m.list, {}, [...((store.getQuery(anyApi.m.list, {}) as string[]) ?? []), tag]);

  test("only the queries an update touches are reported", () => {
    const o = new OptimisticQueryResults();
    o.ingestQueryResultsFromServer(server({ "m:list": [], "m:other": 1 }), new Set());
    expect(o.applyOptimisticUpdate(append("x"), 1)).toEqual([token("m:list")]);
    expect(o.queryResult(token("m:other"))).toBe(1);
  });

  test("updates stack in order; dropping the first keeps the second, re-applied over the server's value", () => {
    const o = new OptimisticQueryResults();
    o.ingestQueryResultsFromServer(server({ "m:list": [] }), new Set());
    o.applyOptimisticUpdate(append("first"), 1);
    o.applyOptimisticUpdate(append("second"), 2);
    expect(o.queryResult(token("m:list"))).toEqual(["first", "second"]);
    // A new server value with nothing reflected yet: both re-applied, in the order they were made.
    o.ingestQueryResultsFromServer(server({ "m:list": ["other"] }), new Set());
    expect(o.queryResult(token("m:list"))).toEqual(["other", "first", "second"]);
    const changed = o.ingestQueryResultsFromServer(server({ "m:list": ["first (saved)"] }), new Set([1]));
    expect(changed).toEqual([token("m:list")]);
    expect(o.queryResult(token("m:list"))).toEqual(["first (saved)", "second"]);
    o.ingestQueryResultsFromServer(server({ "m:list": ["first (saved)", "second (saved)"] }), new Set([2]));
    expect(o.queryResult(token("m:list"))).toEqual(["first (saved)", "second (saved)"]);
  });

  test("an update can set a query to undefined: loading again", () => {
    const o = new OptimisticQueryResults();
    o.ingestQueryResultsFromServer(server({ "m:list": ["a"] }), new Set());
    o.applyOptimisticUpdate((store) => store.setQuery(anyApi.m.list, {}, undefined), 1);
    expect(o.queryResult(token("m:list"))).toBeUndefined();
    o.ingestQueryResultsFromServer(server({ "m:list": ["a"] }), new Set([1]));
    expect(o.queryResult(token("m:list"))).toEqual(["a"]);
  });
});

describe("RequestManager: incomplete requests and connection-state notifications", () => {
  const mutation = (requestId: number): v1.MutationRequest => ({
    type: "Mutation",
    requestId,
    udfPath: "m:x",
    args: [{}],
  });
  const action = (requestId: number): v1.ActionRequest => ({ type: "Action", requestId, udfPath: "m:a", args: [{}] });

  test("hasIncompleteRequests: sent and unanswered only (the unsaved-changes prompt)", () => {
    const rm = new RequestManager(logger, () => {});
    void rm.request(mutation(0), false);
    expect(rm.hasIncompleteRequests()).toBe(false); // not sent yet
    rm.resume();
    expect(rm.hasIncompleteRequests()).toBe(true);
    rm.onResponse({ type: "MutationResponse", requestId: 0, success: true, result: null, ts: 5n, logLines: [] });
    expect(rm.hasIncompleteRequests()).toBe(false); // answered, waiting to be reflected
    expect(rm.hasInflightRequests()).toBe(true);
    void rm.request(action(1), true);
    expect(rm.hasIncompleteRequests()).toBe(true);
    rm.onResponse({ type: "ActionResponse", requestId: 1, success: true, result: null, logLines: [] });
    expect(rm.hasIncompleteRequests()).toBe(false);
  });

  test("the connection state is marked dirty on a request, a response that completes one, a reflection and a restart", () => {
    let dirty = 0;
    const rm = new RequestManager(logger, () => dirty++);
    void rm.request(mutation(0), true);
    expect(dirty).toBe(1);
    void rm.request(action(1), true);
    expect(dirty).toBe(2);
    rm.onResponse({ type: "ActionResponse", requestId: 1, success: true, result: null, logLines: [] });
    expect(dirty).toBe(3);
    rm.onResponse({ type: "MutationResponse", requestId: 0, success: true, result: null, ts: 5n, logLines: [] });
    expect(dirty).toBe(3); // answered, not complete yet
    rm.removeCompleted(4n);
    expect(dirty).toBe(3); // nothing reflected
    rm.removeCompleted(5n);
    expect(dirty).toBe(4);
    rm.restart();
    expect(dirty).toBe(5);
  });
});

// `AdminSync.watch` and `query` around the client's local results: a result the client holds is delivered on the
// next tick, unless it is gone by then (one kept from a subscription just dropped, cleared by a server transition
// that answered the older query set). Seen in CI as a `null` cron run list (STUDY-149 PR 5).
import { expect, test } from "bun:test";
import type { FunctionResult } from "@bunvex/client";
import { AdminSync } from "../src/sync.ts";

/** A socket that never opens: the client stays offline, the test drives its local results. */
class NeverOpens {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

function offline() {
  const sync = new AdminSync({
    url: "http://127.0.0.1:1",
    adminKey: "key",
    webSocketConstructor: NeverOpens as unknown as typeof WebSocket,
  });
  const client = sync.client as unknown as {
    hasLocalQueryResultByToken: (t: string) => boolean;
    localQueryResultByToken: (t: string) => unknown;
  };
  return { sync, client };
}

test("a local result gone before the next tick is not delivered (no null); the read waits for its own", async () => {
  const { sync, client } = offline();
  let held = true;
  client.hasLocalQueryResultByToken = () => held;
  client.localQueryResultByToken = () => (held ? [1] : undefined);
  const results: FunctionResult[] = [];
  const off = sync.watch("q", {}, (r) => results.push(r));
  held = false; // cleared after the subscription saw it, before the tick
  await Bun.sleep(10);
  expect(results).toEqual([]);
  off();
  void sync.close(); // the socket never opened: nothing to wait for
});

test("a local result still held on the next tick is delivered", async () => {
  const { sync, client } = offline();
  client.hasLocalQueryResultByToken = () => true;
  client.localQueryResultByToken = () => [1];
  const value = await sync.query<number[]>("q", {});
  expect(value).toEqual([1]);
  void sync.close(); // the socket never opened: nothing to wait for
});

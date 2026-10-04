// The simple client's optimistic updates (STUDY-65 §3, `browser/simple_client.test.ts` "Optimistic updates are
// applied"): the update runs once, as the mutation is called; the local result and the subscriber's callback
// see its value. Convex's test awaits the socket before it looks; this one also pins what is visible right
// away and after a microtask, so both clients must agree on the timing too. Differential: BunvexClient and the
// official ConvexClient (the oracle), over a socket that never connects.
import { describe, expect, test } from "bun:test";
import { anyApi, BunvexClient } from "@bunvex/client";
import { ConvexClient } from "convex/browser";
import { anyApi as oracleApi } from "convex/server";

class NeverSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  readyState = 0;
  constructor(readonly url: string) {}
  send() {}
  close() {}
}
const options = { webSocketConstructor: NeverSocket as never, unsavedChangesWarning: false };

type Store = { setQuery(...a: unknown[]): void };
type AnyClient = {
  onUpdate(ref: unknown, args: object, cb: (v: unknown) => void): () => void;
  mutation(ref: unknown, args: object, o: { optimisticUpdate: (s: Store) => void }): Promise<unknown>;
  client: { localQueryResult(name: string, args?: object): unknown };
  close(): Promise<void>;
};
const clients: [string, () => AnyClient, Record<string, Record<string, unknown>>][] = [
  ["BunvexClient", () => new BunvexClient("http://127.0.0.1:1", options) as never, anyApi as never],
  [
    "official ConvexClient",
    () => new ConvexClient("http://127.0.0.1:1", { ...options, skipConvexDeploymentUrlCheck: true }) as never,
    oracleApi as never,
  ],
];

for (const [name, make, api] of clients)
  describe(name, () => {
    test("an optimistic update runs once, at the call; its value reaches the local result and the subscriber", async () => {
      const client = make();
      const seen: unknown[] = [];
      const unsubscribe = client.onUpdate(api.m!.read, {}, (v) => seen.push(v));
      expect(client.client.localQueryResult("m:read", {})).toBeUndefined();
      let ran = 0;
      void client
        .mutation(
          api.m!.write,
          {},
          {
            optimisticUpdate: (store) => {
              ran++;
              store.setQuery(api.m!.read, {}, "optimisticValue");
            },
          },
        )
        .catch(() => {});
      // At once: the update ran and the local result has it.
      expect(ran).toBe(1);
      expect(client.client.localQueryResult("m:read", {})).toBe("optimisticValue");
      const atOnce = [...seen];
      await Promise.resolve();
      const afterMicrotask = [...seen];
      await Bun.sleep(10);
      // The subscriber hears it once, synchronously, inside the call (both clients do).
      expect({ atOnce, afterMicrotask, later: seen, ran }).toEqual({
        atOnce: ["optimisticValue"],
        afterMicrotask: ["optimisticValue"],
        later: ["optimisticValue"],
        ran: 1,
      });
      timings[name] = { atOnce, afterMicrotask };
      unsubscribe();
      void client.close();
    });
  });

const timings: Record<string, { atOnce: unknown[]; afterMicrotask: unknown[] }> = {};
test("both clients tell the subscriber at the same moment", () => {
  expect(timings.BunvexClient).toBeDefined();
  expect(timings.BunvexClient).toEqual(timings["official ConvexClient"]!);
});

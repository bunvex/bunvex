// The Worker of `sqlite-worker-reads.ts`: a reader opened from the store's description as an execution worker opens
// one (`openStoreReader`), answering each read posted to it. Messages: the description first, then
// `[id, method, args]`; answers `[id, true, value]` or `[id, false, {name, message}]`.
import type { Persistence, StoreReader } from "@bunvex/core";
import { openStoreReader } from "../../packages/server/src/persistence.ts";

declare const self: Worker;

let store: Promise<Persistence> | null = null;
self.onmessage = async (e: MessageEvent<StoreReader | [number, string, unknown[]]>) => {
  const m = e.data;
  if (!Array.isArray(m)) {
    store = openStoreReader(m, { cacheBytes: 16 * 1024 * 1024 });
    return;
  }
  const [id, method, args] = m;
  try {
    const s = (await store) as unknown as Record<string, (...a: unknown[]) => unknown>;
    self.postMessage([id, true, await s[method]!(...args)]);
  } catch (err) {
    const x = err as Error;
    self.postMessage([id, false, { name: x.name, message: x.message }]);
  }
};

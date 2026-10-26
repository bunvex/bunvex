// STUDY-190 prototype, the worker side: one Bun Worker thread with its own connection to the SQLite store, as a
// writer (candidate a: a group's rows, its commit and its fsync) or a reader (candidate b: index scans and
// document gets on a WAL snapshot). It opens the store with the product's own driver, so the statements and the
// pragmas are the product's; the main thread keeps the store's lock (a second connection of the same process
// does not get it), and the writer skips the lock check, the main thread having checked it.
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";

declare const self: Worker;

type Init = { path: string; durable: boolean; role: "writer" | "reader"; cacheBytes?: number };
type Msg =
  | { op: "group"; id: number; commits: { ts: bigint; docs: any[]; idx: any[] }[]; entries: any[] }
  | { op: "entries"; id: number; entries: any[] }
  | { op: "scan"; id: number; args: [string, string, Uint8Array, Uint8Array, bigint, number, boolean] }
  | { op: "get"; id: number; args: [string, string, bigint] }
  | { op: "getVersions"; id: number; args: [string, string[], bigint] };

let store: SqlitePersistence | null = null;

self.onmessage = (e: MessageEvent<Init | Msg>) => {
  const m = e.data;
  if ("path" in m) {
    // A reader's page cache is its own: a quarter of the default each, so a pool of 4 holds what one did.
    store = new SqlitePersistence(m.path, { durable: m.durable, allowReadOnly: true, cacheBytes: m.cacheBytes });
    // Only the main thread's connection holds the store's lock; this one writes under it.
    if (m.role === "writer") (store as any).assertWriter = () => {};
    self.postMessage({ ready: true });
    return;
  }
  const s = store!;
  try {
    switch (m.op) {
      case "group": {
        for (const c of m.commits) s.apply(c.ts, c.docs, c.idx);
        if (m.entries.length) s.writeIndexEntries(m.entries);
        s.flush();
        self.postMessage({ id: m.id });
        return;
      }
      case "entries":
        s.writeIndexEntries(m.entries);
        self.postMessage({ id: m.id });
        return;
      case "scan":
        self.postMessage({ id: m.id, result: s.scan(...m.args) });
        return;
      case "get":
        self.postMessage({ id: m.id, result: s.get(...m.args) });
        return;
      case "getVersions":
        self.postMessage({ id: m.id, result: s.getVersions(...m.args) });
        return;
    }
  } catch (err) {
    self.postMessage({
      id: (m as { id: number }).id,
      error: { message: (err as Error).message, name: (err as Error).name },
    });
  }
};

// Driver module for the conformance suite: SQLite, its reads answered by a Worker on a reader connection of its own
// (STUDY-194 §10.2, 2b step ii), as an execution worker reads the store the main thread writes. Writes, the lease
// and everything else go to the writer (`SqlitePersistence`); `get`, `getVersions`, `scan`, `maxTs` and `getGlobal`
// cross to `sqlite-reader-worker.ts`. In $DIR (default ./.data/conformance).
import { mkdirSync, rmSync } from "node:fs";
import type { OpenOptions, Persistence } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";

const dir = process.env.DIR ?? `${import.meta.dir}/../../.data/conformance`;
const path = `${dir}/sqlite-worker-reads.db`;
const READS = new Set(["get", "getVersions", "scan", "maxTs", "getGlobal"]);

export async function open(fresh: boolean, opts: OpenOptions = {}): Promise<Persistence> {
  mkdirSync(dir, { recursive: true });
  if (fresh) for (const s of ["", "-wal", "-shm"]) rmSync(`${path}${s}`, { force: true });
  const writer = new SqlitePersistence(path, { durable: true, ...opts });
  const worker = new Worker(new URL("./sqlite-reader-worker.ts", import.meta.url).href);
  worker.postMessage(writer.reader());
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 0;
  worker.onmessage = (e: MessageEvent<[number, boolean, unknown]>) => {
    const [id, ok, value] = e.data;
    const p = pending.get(id)!;
    pending.delete(id);
    if (ok) p.resolve(value);
    else p.reject(Object.assign(new Error((value as Error).message), { name: (value as Error).name }));
  };
  const read =
    (method: string) =>
    (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        worker.postMessage([id, method, args]);
      });
  return new Proxy(writer, {
    get(target, key, receiver) {
      if (typeof key === "string" && READS.has(key)) return read(key);
      if (key === "close")
        return () => {
          worker.terminate();
          return target.close();
        };
      const v = Reflect.get(target, key, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Persistence;
}

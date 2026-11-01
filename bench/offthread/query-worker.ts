// SPIKE (STUDY-194 2b, owner 2026-11-01): a query worker, not product code. Its own reader engine on the store the
// main thread writes (a read-only SQLite connection, the catalog at start), the bench's functions registered, and
// the call runner: a request's text in, its outcome's text out. Nothing it holds follows a push or a new table.
import { Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { Functions } from "bunvex/server";
import { bench, benchSchema } from "../functions.ts";

declare const self: Worker;

type Init = { path: string; instanceSecret: string; instanceName: string; cacheBytes?: number };
let ready: Promise<{ engine: Engine; functions: Functions }> | null = null;

self.onmessage = async (e: MessageEvent<Init | [number, string]>) => {
  const m = e.data;
  if (!Array.isArray(m)) {
    ready = (async () => {
      const p = new SqlitePersistence(m.path, { durable: false, reader: true, cacheBytes: m.cacheBytes });
      const engine = await new Engine(benchSchema, p, {
        instanceSecret: m.instanceSecret,
        instanceName: m.instanceName,
      }).openReader();
      const functions = new Functions(engine).register("bench", bench);
      return { engine, functions };
    })();
    await ready;
    self.postMessage("ready");
    return;
  }
  const [id, request] = m;
  try {
    const { engine, functions } = await ready!;
    const outcome = await engine.runCallText(request, functions.spikeBodies);
    self.postMessage([id, outcome]);
  } catch (e) {
    console.error("query worker:", e);
    self.postMessage([id, null, String((e as Error)?.stack ?? e)]);
  }
};

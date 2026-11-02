// The execution worker module (STUDY-194 §4, STUDY-190 PR 2): what `ExecutionWorkers` starts in each Bun Worker for
// the server's queries (`query-workers.ts`). `scripts/build-binary.ts` embeds it in `bunvex-local-backend` as an entry
// point of its own.
//
// It opens the store's reader and an engine that follows the main thread's (`Engine.follow`): each request runs on
// that engine at its own ts, with the metadata epoch it names, against the code epoch the call names
// (`WorkerCode`), its table counts and searches asked of the main thread. A call's text is `<code epoch>:<request>`.
import { AsyncLocalStorage } from "node:async_hooks";
import { defineSchema, Engine, followerOpsOver, onUserTimeResume } from "@bunvex/core";
import { WorkerCode } from "./execution-code.ts";
import { ask, running, serveExecutionThread } from "./execution-thread.ts";
import { Functions } from "./functions.ts";
import { openStoreReader } from "./persistence.ts";
import type { QueryWorkerInit } from "./query-workers.ts";
import { FileStorage } from "./storage.ts";

let engine: Engine | null = null;
let code: WorkerCode | null = null;
/** The call whose JavaScript runs: progress is marked by it each time it resumes after a store call. */
const calls = new AsyncLocalStorage<number>();

/** The blobs a query never touches (`ctx.storage.getUrl` signs a URL; reading a file is an action's). */
const noBlobs = new Proxy({} as ConstructorParameters<typeof FileStorage>[1], {
  get: () => () => Promise.reject(new Error("an execution worker does not read or write files")),
});

serveExecutionThread({
  async init(text) {
    const o = JSON.parse(text) as QueryWorkerInit;
    const store = await openStoreReader(o.store, { cacheBytes: o.cacheBytes });
    const e = new Engine(defineSchema({}), store, { callCodec: false, indexCache: false });
    e.follow(o.start, followerOpsOver(ask), { indexCacheBytes: o.indexCacheBytes });
    engine = e;
    const files = o.filesOrigin === null ? null : new FileStorage(e, noBlobs, o.filesOrigin);
    code = new WorkerCode(() => {
      const f = new Functions(e);
      f.builtinEnv = o.builtinEnv;
      f.userTimeoutMs = o.userTimeoutMs;
      f.systemTimeoutMs = o.systemTimeoutMs;
      if (files) f.fileStorage = files;
      return f;
    });
    onUserTimeResume(() => {
      const id = calls.getStore();
      if (id !== undefined) running(id);
    });
  },
  message(text) {
    if (code!.hear(text)) return;
    if (text[0] === "m") engine!.hearMetadata(text);
    else if (text[0] === "w") engine!.hearCommits(text);
    else throw new Error(`an execution worker got a message it does not know (${JSON.stringify(text.slice(0, 20))})`);
  },
  call(id, text) {
    const colon = text.indexOf(":");
    const epoch = Number(text.slice(0, colon));
    return calls.run(id, async () => {
      const functions = await code!.at(epoch);
      return engine!.runRequestText(text.slice(colon + 1), functions.callBodies);
    });
  },
  close() {
    return engine?.persistence.close();
  },
});

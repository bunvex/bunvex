// A worker for `execution-code.test.ts`: it holds code as an execution worker does (`WorkerCode`) and describes an
// epoch's registry on request. Messages: the code messages (`v`, `k`, `f`), then `?<epoch>` (describe it: the
// answer is `describeCode()` as JSON, or `!<message>`) and `#` (what it holds).
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { WorkerCode } from "../../src/execution-code.ts";
import { Functions } from "../../src/functions.ts";

declare const self: Worker;

const engine = new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }));
const code = new WorkerCode(() => new Functions(engine));

self.onmessage = async (e: MessageEvent<string>) => {
  const m = e.data;
  if (code.hear(m)) return;
  if (m === "#") return self.postMessage(JSON.stringify(code.held));
  if (m[0] === "?")
    try {
      const f = await code.at(Number(m.slice(1)));
      self.postMessage(JSON.stringify(f.describeCode()));
    } catch (err) {
      self.postMessage(`!${(err as Error).message}`);
    }
};

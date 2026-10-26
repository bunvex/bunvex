// The SQLite store's writer thread (STUDY-190 §4.1): a Bun Worker with its own connection to the store, which runs
// every write of the store (`SqliteWriter`), one message at a time, in the order they were posted. Each message is
// answered once its transaction has committed, so a group is acknowledged only after its fsync here.
//
// The main thread posts the shared cell `close` signals on, then the connection's settings (JSON), then the writes
// (`sqlite-writer.ts`). Its answers are short JSON strings: `{"id":n}`, `{"id":n,"n":rows}`, or `{"id":n,"error":…}`.
// It holds no lock of its own: the main thread holds the store's single-writer lock (PERSIST-01 C7) and posts a
// write only while it does.
import { Database } from "bun:sqlite";
import { SqliteWriter, WriteOp, writerPragmas } from "./sqlite-writer.ts";

declare const self: Worker;

let signal: Int32Array | null = null;
let db: Database | null = null;
let writer: SqliteWriter | null = null;
/** Why the connection could not be opened: every write fails with it. */
let openError: unknown = null;

function open(init: { path: string; durable: boolean; cacheKiB: number }) {
  try {
    db = new Database(init.path, { readwrite: true, create: false });
    db.exec(writerPragmas(init.durable, init.cacheKiB));
    writer = new SqliteWriter(db);
  } catch (e) {
    db?.close();
    db = null;
    openError = e;
  }
}

/** Every write posted before it is done (messages run in order): close the connection, say so, end the thread. */
function close() {
  writer?.close();
  db?.close();
  if (signal) {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
  process.exit(0);
}

self.onmessage = (e: MessageEvent<string | SharedArrayBuffer>) => {
  const m = e.data;
  if (typeof m !== "string") {
    signal = new Int32Array(m);
    return;
  }
  if (m[0] === "{") return open(JSON.parse(m));
  if (m === WriteOp.Close) return close();
  const id = Number(m.slice(1, m.indexOf(":")));
  try {
    if (openError) throw openError;
    const n = writer!.run(m);
    self.postMessage(n === undefined ? `{"id":${id}}` : `{"id":${id},"n":${n}}`);
  } catch (err) {
    const x = err as { name?: string; message?: string; code?: unknown };
    self.postMessage(
      JSON.stringify({
        id,
        error: { name: x?.name ?? "Error", message: x?.message ?? String(err), code: x?.code },
      }),
    );
  }
};

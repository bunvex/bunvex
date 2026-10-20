// The local log sink closes the file it syncs even when the sync fails (STUDY-174 S2, I-27). Convex's `LocalSink`
// (crates/log_streaming/src/sinks/local_sink.rs `process_events`) holds the file for one attempt and drops it, closed,
// on any error; then it retries. A sync that kept failing here left one open handle per retry.
import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const real = { ...fsp };
const handles = { opened: 0, closed: 0, failSync: true };
mock.module("node:fs/promises", () => ({
  ...real,
  open: async (...a: Parameters<typeof real.open>) => {
    const h = await real.open(...a);
    handles.opened++;
    return new Proxy(h, {
      get(target, key) {
        if (key === "sync")
          return async () => {
            if (handles.failSync) throw new Error("EIO: i/o error, fsync");
            return target.sync();
          };
        if (key === "close")
          return async () => {
            handles.closed++;
            return target.close();
          };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  },
}));
const { LocalSink, defaultLogSinkOptions } = await import("../src/log-sinks.ts");

const dir = mkdtempSync(join(tmpdir(), "bunvex-local-sink-"));
afterAll(() => {
  mock.restore();
  rmSync(dir, { recursive: true, force: true });
});

test("a failing sync closes its handle on every attempt; the retry that syncs delivers", async () => {
  const path = join(dir, "logs.jsonl");
  const sink = new LocalSink(path, { ...defaultLogSinkOptions(), localBackoffMs: [1, 1] });
  const errors = console.error;
  console.error = () => {};
  try {
    const sent = sink.send([{ timestamp: 1, event: { topic: "verification" } } as never]);
    for (let i = 0; i < 200 && handles.opened < 5; i++) await Bun.sleep(2);
    handles.failSync = false;
    await sent;
  } finally {
    console.error = errors;
  }
  expect(handles.opened).toBeGreaterThanOrEqual(5);
  // Every handle the sink opened is closed: none left behind by a failed sync.
  expect(handles.closed).toBe(handles.opened);
  expect(readFileSync(path, "utf8")).toContain(`"topic":"verification"`);
});

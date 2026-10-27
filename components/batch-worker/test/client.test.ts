// Upstream's client tests (`src/client/index.test.ts` of get-convex/batch-worker 0.3.6, STUDY-196 §1.9), ported to
// `@bunvex/testing`: an app that installs the package by its name (fixtures/app) pings the worker from its own
// mutations, and the loop runs on the virtual clock as `finishAllScheduledFunctions` moves it, through the
// component's stale-snapshot work query and the app's worker mutation.
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api is untyped
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";

const worker = (anyApi as any).worker;
const APP = join(import.meta.dir, "fixtures", "app");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
function deployment() {
  const t = bunvexTest({ cwd: APP });
  open.push(t);
  return t;
}
/** Drain every scheduled function: the cooldown polls every 10 ms for 100 ms, so allow more steps than the default. */
const drain = (t: TestBunvex) => t.finishAllScheduledFunctions(undefined, 1000);

describe("Worker client", () => {
  test("ping drives the loop and processes work", async () => {
    const t = deployment();
    await t.mutation(worker.enqueue, { value: 1 });
    await t.mutation(worker.enqueue, { value: 2 });
    expect((await t.query(worker.status, {}))?.kind).toBe("running");

    await drain(t);

    expect(await t.query(worker.remaining, {})).toBe(0);
    expect((await t.query(worker.status, {}))?.kind).toBe("idle");
  });

  test("stop halts the worker; start resumes it", async () => {
    const t = deployment();
    await t.mutation(worker.enqueue, { value: 1 });
    await t.mutation(worker.stopWorker, {});
    expect((await t.query(worker.status, {}))?.kind).toBe("stopped");

    await t.mutation(worker.startWorker, {});
    expect((await t.query(worker.status, {}))?.kind).toBe("running");
    await drain(t);
    expect(await t.query(worker.remaining, {})).toBe(0);
  });
});

describe("Cursor", () => {
  test("round-trips from the query back into the next call's args", async () => {
    const t = deployment();
    for (const seq of [0n, 1n, 2n, 3n]) await t.mutation(worker.enqueueMark, { seq });
    // Nothing deletes the marks: the query moves on only because the cursor comes back as `args.cursor`.
    await drain(t);
    expect(await t.query(worker.batches, {})).toEqual([
      [0n, 1n],
      [2n, 3n],
    ]);
    expect(await t.query(worker.markCursor, {})).toBe(4n);
  });

  test("a cursor from the mutation overrides the query's", async () => {
    const t = deployment();
    for (const seq of [0n, 1n]) await t.mutation(worker.enqueueMark, { seq, partial: true });
    await drain(t);
    // The query proposed 2n each time; the mutation claimed only each batch's first mark.
    expect(await t.query(worker.batches, {})).toEqual([[0n, 1n], [1n]]);
    expect(await t.query(worker.markCursor, {})).toBe(2n);
  });

  test("setCursor overwrites it, and clears it when omitted", async () => {
    const t = deployment();
    await t.mutation(worker.enqueueMark, { seq: 0n });
    await drain(t);
    expect(await t.query(worker.markCursor, {})).toBe(1n);

    await t.mutation(worker.setMarkCursor, { cursor: 99n });
    expect(await t.query(worker.markCursor, {})).toBe(99n);

    await t.mutation(worker.setMarkCursor, {});
    expect(await t.query(worker.markCursor, {})).toBe(null);
  });

  test("can be seeded before the worker processes anything", async () => {
    const t = deployment();
    await t.mutation(worker.seedMarks, { seqs: [0n, 1n, 2n, 3n], cursor: 2n });
    await drain(t);
    expect(await t.query(worker.batches, {})).toEqual([]);

    // A ping does not resume a stopped worker, so the seeded cursor stays.
    await t.mutation(worker.enqueueMark, { seq: 4n });
    await drain(t);
    expect(await t.query(worker.batches, {})).toEqual([]);

    // `start` resumes it, and the scan begins at the seeded cursor.
    await t.mutation(worker.startMarks, {});
    await drain(t);
    expect(await t.query(worker.batches, {})).toEqual([[2n, 3n], [4n]]);
  });

  test("can be a type other than a commit timestamp", async () => {
    const t = deployment();
    for (const letter of ["a", "b", "c"]) await t.mutation(worker.enqueueLetter, { letter });
    await drain(t);
    expect(await t.query(worker.letterBatches, {})).toEqual([["a", "b"], ["c"]]);
    expect(await t.query(worker.letterCursor, {})).toBe("c");
  });
});

// An internal error inside the committer's drain (a bug of bunvex, not a persistence failure) still answers
// every commit exactly once: the committer stops (fail-stop), commits that are durable are answered as
// committed, and the others are refused. Before, a throwing `atTs` left its whole group unanswered, and a
// throwing `onBatch` or write throughput limiter left a durable batch unanswered: the mutations hung.
import { expect, test } from "bun:test";
import { CommitListenerError, Committer, CommitterInternalError, CommitterStoppedError } from "../src/committer.ts";
import type { DocWrite, IndexWrite, Persistence } from "../src/persistence/index.ts";
import type { CommitSpans } from "../src/tracing.ts";

const DOC: DocWrite = { table: "t", id: "d1", json: "{}", prevTs: null };
const IDX: IndexWrite = { index: "i", key: Uint8Array.of(1), table: "t", id: "d1" };
const store = () => ({ apply() {}, async flush() {}, isTransient: () => false }) as unknown as Persistence;
type Put = Partial<Parameters<Committer["commit"]>[0]>;
const put = (c: Committer, o: Put = {}) =>
  c.commit({ snapshot: c.visibleTs, reads: [], docs: [DOC], idx: [IDX], ...o });

/** Each commit's outcome once settled, or "pending" after `ms`. */
async function outcomes(ps: Promise<bigint>[], ms = 100) {
  const out: string[] = ps.map(() => "pending");
  for (const [i, p] of ps.entries())
    p.then(
      (ts) => {
        out[i] = `committed at ${ts}`;
      },
      (e) => {
        out[i] = e instanceof CommitterStoppedError ? "refused: stopped" : `refused: ${e.constructor.name}`;
      },
    );
  await new Promise((r) => setTimeout(r, ms));
  return out;
}

test("a throwing atTs: the committer stops and every commit of its group is answered once, none left pending", async () => {
  const c = new Committer(store(), {}, () => 0n);
  expect(await put(c)).toBe(1n);
  const settles: number[] = [0, 0, 0];
  const trace = (i: number) => ({ settle: () => settles[i]!++ }) as unknown as CommitSpans;
  const ps = [
    // Refused by validation (it read key 1 before ts 1 wrote it), before the error: it keeps that answer.
    put(c, { snapshot: 0n, reads: [{ index: "i", lo: Uint8Array.of(0), hi: Uint8Array.of(9) }], trace: trace(0) }),
    put(c, {
      trace: trace(1),
      atTs: () => {
        throw new Error("bad atTs");
      },
    }),
    put(c, { trace: trace(2) }),
  ];
  expect(await outcomes(ps)).toEqual(["refused: ConflictError", "refused: stopped", "refused: stopped"]);
  // A bug of bunvex, not of the store: the stop says "internal error", never "persistence failure".
  expect(c.stopped?.message).toBe("the committer stopped after an internal error: bad atTs");
  expect(c.stopped?.persistenceFailure).toBe(false);
  expect(c.stopped?.cause).toBeInstanceOf(CommitterInternalError);
  expect(settles).toEqual([1, 1, 1]); // each trace settled once
  expect(c.visibleTs).toBe(1n);
});

for (const [hook, arm] of [
  [
    "onBatch",
    (c: Committer) => {
      c.onBatch = () => {
        throw new Error("metrics");
      };
    },
  ],
  [
    "write throughput",
    (c: Committer) => {
      c.writeThroughput = {
        record: () => {
          throw new Error("metrics");
        },
      } as never;
    },
  ],
] as const)
  test(`a throwing ${hook}: its durable batch is answered as committed, later batches refused, the committer names it`, async () => {
    const c = new Committer(store(), {}, () => 0n, {}, { maxDocuments: 1 });
    arm(c);
    const ps = [put(c), put(c)];
    expect(await outcomes(ps)).toEqual(["committed at 1", "refused: stopped"]);
    expect(c.stopped?.cause).toBeInstanceOf(CommitListenerError);
    expect(c.stopped?.persistenceFailure).toBe(false);
    expect(c.stopped?.message).toBe(
      `the committer stopped after an internal error in commit listener ${JSON.stringify(hook)}: metrics`,
    );
    expect(c.visibleTs).toBe(1n);
  });

test("a persistence failure still says so: a throwing apply, a failed flush, a lost lease", async () => {
  const failing = (where: "apply" | "flush") =>
    ({
      apply() {
        if (where === "apply") throw new Error("disk");
      },
      async flush() {
        if (where === "flush") throw new Error("disk");
      },
      isTransient: () => false,
    }) as unknown as Persistence;
  for (const [where, text] of [
    ["apply", "the committer stopped after a persistence failure: disk"],
    [
      "flush",
      "the committer stopped after a persistence failure: write failed, unsure if the group committed to disk: disk",
    ],
  ] as const) {
    const c = new Committer(failing(where), {}, () => 0n);
    expect(await outcomes([put(c)])).toEqual(["refused: stopped"]);
    expect(c.stopped?.message).toBe(text);
    expect(c.stopped?.persistenceFailure).toBe(true);
  }
  const c = new Committer(store(), {}, () => 0n);
  c.fail(new Error("lease lost"));
  expect(c.stopped?.message).toBe("the committer stopped after a persistence failure: lease lost");
  expect(c.stopped?.persistenceFailure).toBe(true);
});

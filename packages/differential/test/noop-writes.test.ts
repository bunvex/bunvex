// A patch or replace that leaves the document as it was writes nothing, as Convex's `patch_inner` /
// `replace_inner` (crates/database/src/transaction.rs at 72ce13c): the function log records reads only. The
// generated programs found it (seed 578652894: insert `{x: 2}`, then patch `{x: 2}`). STUDY-187 §2.10.
// Skipped, with a note, when Convex's backend is not there.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";
import { type Call, compare, type Program, type Ref } from "../harness/runner.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`differential: skipped, no Convex backend at ${ORACLE_BIN}`);

const seed: Call = {
  kind: "apply",
  ops: [{ kind: "insert", table: "b", doc: { x: 2, y: [1, { z: "s" }] }, as: "r0" }],
};
const r0: Ref = { ref: "r0" };

const PROGRAMS: Record<string, Program> = {
  "a patch with the same values": [seed, { kind: "apply", ops: [{ kind: "patch", id: r0, fields: { x: 2 } }] }],
  "an empty patch": [seed, { kind: "apply", ops: [{ kind: "patch", id: r0, fields: {} }] }],
  "a nested mutation's patch with the same values": [
    seed,
    { kind: "apply", ops: [{ kind: "nested", ops: [{ kind: "patch", id: r0, fields: { y: [1, { z: "s" }] } }] }] },
  ],
  "a replace with the same document": [
    seed,
    { kind: "apply", ops: [{ kind: "replace", id: r0, doc: { x: 2, y: [1, { z: "s" }] } }] },
  ],
  "a patch back to the stored value after another in the transaction (written: it changes the pending one)": [
    seed,
    {
      kind: "apply",
      ops: [
        { kind: "patch", id: r0, fields: { x: 3 } },
        { kind: "patch", id: r0, fields: { x: 2 } },
      ],
    },
  ],
  "a patch that changes a value (written)": [
    seed,
    { kind: "apply", ops: [{ kind: "patch", id: r0, fields: { x: 3 } }] },
  ],
};

describe.skipIf(!ready)("a write that changes nothing, on Convex and on bunvex", () => {
  for (const [name, program] of Object.entries(PROGRAMS))
    test(name, async () => {
      const [oracle, bunvex] = await startAll([startConvex(), startBunvex()]);
      try {
        expect(await compare(oracle, bunvex, program, { log: true })).toEqual([]);
      } finally {
        await Promise.all([oracle.stop(), bunvex.stop()]);
      }
    }, 120_000);
});

// An OCC conflict names the component whose table it is (STUDY-187 §2.5), as Convex's `OccInfo.component_path`
// (database/src/tests/mod.rs `test_occ_error_component_path_for_child_component`, `…_is_none_for_root`): the
// error's info carries the component, null at the root, and its message names the table. The store is
// component-store.ts's: a root with `messages`, and a `counter` component with `counters` and `messages`.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, OccError } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import type { Tx } from "../src/tx.ts";
import { buildComponentStore, rootSchema } from "./component-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-occ-component-"));
  dirs.push(dir);
  const s = await buildComponentStore(join(dir, "log"));
  const e = await new Engine(rootSchema, await MemoryPersistence.open(s.path, { durable: false }), {
    maxRetries: 0,
  }).init();
  return { s, e };
}

/** A mutation that reads `table`'s first document in `space` and loses it to a rival write before it commits. */
async function lose(e: Engine, space: string | null, table: string, fields: (n: number) => Record<string, unknown>) {
  const inSpace = <T>(db: Tx, fn: () => Promise<T>) => (space ? db.inComponent(space, fn) : fn());
  try {
    await e.mutation(async (db: Tx) => {
      const doc = (await inSpace(db, () => db.query(table).first()))!;
      await e.mutation(
        (rival: Tx) => inSpace(rival, () => rival.patch(table, doc._id as string, fields(1))),
        "m:rival",
      );
      await inSpace(db, () => db.patch(table, doc._id as string, fields(2)));
    }, "m:mine");
  } catch (x) {
    return x as OccError;
  }
  throw new Error("no conflict");
}

test("in a component: the component's id, and its table named", async () => {
  const { s, e } = await setup();
  try {
    const err = await lose(e, s.ids.counter, "counters", (n) => ({ n }));
    expect(err).toBeInstanceOf(OccError);
    expect(err.info).toMatchObject({ table: "counters", componentId: s.ids.counter });
    expect(err.message).toStartWith('Documents read from or written to the "counters" table changed');
  } finally {
    await e.close();
  }
});

test("at the root: no component", async () => {
  const { e } = await setup();
  try {
    const err = await lose(e, null, "messages", (n) => ({ text: `edit ${n}` }));
    expect(err.info).toMatchObject({ table: "messages", componentId: null });
  } finally {
    await e.close();
  }
});

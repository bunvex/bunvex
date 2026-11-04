// Components as a push leaves them, for the tests of export, import and streaming export (STUDY-204): `counter`
// and `second` under the root, `inner` under `counter`, each namespace with its own `messages` (and `counter` its
// `counters`), one document each, written in its namespace; the root's `messages` has one too.
import { componentRow, type Engine } from "@bunvex/core";

export async function addComponents(engine: Engine, opts: { rootMessage?: boolean } = {}) {
  const ids = {
    counter: await engine.initializeComponentNamespace(),
    second: await engine.initializeComponentNamespace(),
    inner: await engine.initializeComponentNamespace(),
  };
  await engine.mutation((db) =>
    db.asSystem(async () => {
      const definitionId = await db.insert("_component_definitions", { path: "c" } as never);
      const root = await db.insert(
        "_components",
        componentRow({ definitionId, parent: null, name: null, state: "active", httpPrefix: null }) as never,
      );
      const add = (id: string, parent: string, name: string) =>
        db.importInsert(engine.catalog.table("_components")!, {
          _id: id,
          ...componentRow({ definitionId, parent, name, args: [], env: [], state: "active", httpPrefix: null }),
        });
      await add(ids.counter, root, "counter");
      await add(ids.second, root, "second");
      await add(ids.inner, ids.counter, "inner");
    }),
  );
  await engine.mutation(async (db) => {
    if (opts.rootMessage ?? true) await db.insert("messages", { text: "root" });
    for (const [name, id] of Object.entries(ids))
      await db.inComponent(id, async () => {
        await db.insert("messages", { body: `in ${name}` });
        if (name === "counter") await db.insert("counters", { name, value: 1n });
      });
  });
  return ids;
}

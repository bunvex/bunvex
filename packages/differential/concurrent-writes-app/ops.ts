// Database calls in flight at the same time in one mutation: each scenario starts its calls without awaiting them,
// then reports how each settled and the document afterwards.
import { mutationGeneric } from "convex/server";
import { v } from "convex/values";

type Db = Parameters<Parameters<typeof mutationGeneric>[0]["handler"]>[0]["db"];

const settle = async (calls: Promise<unknown>[]) =>
  (await Promise.allSettled(calls)).map((r) =>
    r.status === "fulfilled"
      ? { ok: r.value ?? null }
      : { error: String((r.reason as Error).message).replace(/[a-z0-9]{32}/g, "<id>") },
  );

const strip = (doc: Record<string, unknown> | null) => {
  if (!doc) return null;
  const { _id, _creationTime, ...fields } = doc;
  return fields;
};

const SCENARIOS: Record<string, (db: Db, id: string) => Promise<unknown>[]> = {
  deleteDelete: (db, id) => [db.delete(id as never), db.delete(id as never)],
  deletePatch: (db, id) => [db.delete(id as never), db.patch(id as never, { b: 2 } as never)],
  patchDelete: (db, id) => [db.patch(id as never, { b: 2 } as never), db.delete(id as never)],
  patchPatch: (db, id) => [db.patch(id as never, { b: 2 } as never), db.patch(id as never, { c: 3 } as never)],
  replacePatch: (db, id) => [db.replace(id as never, { r: 1 } as never), db.patch(id as never, { c: 3 } as never)],
  patchReplace: (db, id) => [db.patch(id as never, { c: 3 } as never), db.replace(id as never, { r: 1 } as never)],
  deleteGet: (db, id) => [db.delete(id as never), db.get(id as never).then((d) => strip(d as never))],
  getDelete: (db, id) => [db.get(id as never).then((d) => strip(d as never)), db.delete(id as never)],
  patchGet: (db, id) => [db.patch(id as never, { b: 2 } as never), db.get(id as never).then((d) => strip(d as never))],
  deleteQuery: (db, id) => [
    db.delete(id as never),
    db
      .query("docs" as never)
      .collect()
      .then((ds) => ds.map((d) => strip(d as never))),
  ],
  patchQuery: (db, id) => [
    db.patch(id as never, { b: 2 } as never),
    db
      .query("docs" as never)
      .collect()
      .then((ds) => ds.map((d) => strip(d as never))),
  ],
  insertQuery: (db) => [
    db.insert("docs" as never, { n: 2 } as never).then(() => "inserted"),
    db
      .query("docs" as never)
      .collect()
      .then((ds) => ds.length),
  ],
};

export const run = mutationGeneric({
  args: { scenario: v.string() },
  handler: async ({ db }, { scenario }) => {
    for (const d of await db.query("docs" as never).collect()) await db.delete((d as { _id: never })._id);
    const id = (await db.insert("docs" as never, { a: 1 } as never)) as string;
    const results = await settle(SCENARIOS[scenario]!(db, id));
    return { results, after: strip((await db.get(id as never)) as never) };
  },
});

export const names = mutationGeneric({ args: {}, handler: async () => Object.keys(SCENARIOS) });

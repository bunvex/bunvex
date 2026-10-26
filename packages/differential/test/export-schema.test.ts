// A streaming export's JSON Schema when a table's shape is not an object (STUDY-187 §2.8): a document with more
// fields than `MAX_OBJECT_FIELDS` makes it a record, and the schema is read from the table's definition in the
// active schema, or the request fails without one. `/api/json_schemas` on Convex's backend (the oracle) and on
// bunvex's, each table driven to that shape in turn, compared answer by answer. Without an active schema
// (`NoSchemaForExport`) is the server's test: bunvex's push of an app with no schema activates an empty one
// where Convex's clears the active schema (`SchemaModel::apply(None)`), reported separately. Skipped, with a
// note, when Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`export-schema: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = join(import.meta.dir, "../export-schema-app");

async function schemas(b: Backend, query = "") {
  const r = await fetch(`${b.url}/api/json_schemas${query}`, {
    headers: { authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}` },
  });
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: r.status, body };
}

async function mutate(b: Backend, path: string, args: unknown) {
  const r = await b.call("mutation", path, args);
  if (!r.ok) throw new Error(`${b.name} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
}

/** Each table in turn holds one wide document; its JSON Schemas, in each format, then the table emptied. */
async function wideTables(backends: Backend[], tables: string[]) {
  for (const table of tables) {
    const answers = [];
    for (const b of backends) {
      await mutate(b, "wide:insert", { table });
      const one = [];
      for (const q of ["", "?deltaSchema=true", "?byComponent=true&format=json"])
        one.push({ table, q, ...(await schemas(b, q)) });
      answers.push(one);
      await mutate(b, "wide:clear", { table });
    }
    expect(answers[1]).toEqual(answers[0]!);
  }
}

describe.skipIf(!ready)("json_schemas falls back to the active schema, on Convex and on bunvex", () => {
  let convex: Backend;
  let bunvex: Backend;
  beforeAll(async () => {
    [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("a record-shaped table: its definition, a union of objects, no definition", async () => {
    await wideTables([convex, bunvex], ["loose", "posts", "pairs", "deep", "other"]);
  });
});

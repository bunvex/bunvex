// A push without a schema (STUDY-187 X3 follow-up): Convex's `SchemaModel::apply(None)` marks the namespace's active
// schema `overwritten` (`clear_active`) and adds no `_schemas` row, and `IndexModel::apply` drops every index of it.
// The app of `no-schema-app/` (with its component `kv`, which has a schema too) is deployed with both schemas, then
// without the app's `schema.ts` (twice), then with it but without the component's, then with both again. Compared
// on each backend after each deploy: `get_schema`, a streaming export's JSON Schema for a table whose shape is a
// record (it needs the active schema: `NoSchemaForExport`), a query by the app's index and one by the component's;
// at the end, the `_schemas` rows read straight from the SQLite store, by creation time. Local only: skipped, with
// a note, when Convex's backend is not there.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, newStore, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`push-without-schema: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../no-schema-app");

/** The component's directory, beside the app's files; for bunvex, its own config file names and imports. */
function prepareComponent(project: string, dir: "convex" | "bunvex") {
  const fns = join(project, dir);
  cpSync(join(APP, "kv"), join(fns, "kv"), { recursive: true });
  if (dir === "convex") return;
  for (const d of [fns, join(fns, "kv")]) {
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".ts")) continue;
      const path = join(d, name);
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .replaceAll('"convex/server"', '"@bunvex/server"')
          .replaceAll('"convex/values"', '"@bunvex/values"')
          .replaceAll("./kv/convex.config", "./kv/bunvex.config"),
      );
    }
    renameSync(join(d, "convex.config.ts"), join(d, "bunvex.config.ts"));
  }
}

type Json = Record<string, unknown>;
/** The newest live version of every `_schemas` row (a `schema` text and a tagged `state`), by creation time. */
function schemaRows(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db
      .query(
        `select d.json_value as j from documents d
         join (select table_id, id, max(ts) as ts from documents group by table_id, id) m
           on d.table_id = m.table_id and d.id = m.id and d.ts = m.ts
         where d.deleted = 0`,
      )
      .all() as { j: string | Uint8Array }[];
    return rows
      .map((r) => JSON.parse(typeof r.j === "string" ? r.j : new TextDecoder().decode(r.j)) as Json)
      .filter((d) => typeof d.schema === "string" && typeof (d.state as Json | undefined)?.state === "string")
      .sort((a, b) => (a._creationTime as number) - (b._creationTime as number))
      .map((r) => ({
        state: (r.state as { state: string }).state,
        tables: (JSON.parse(r.schema as string) as { tables: { tableName: string }[] }).tables.map((t) => t.tableName),
      }));
  } finally {
    db.close();
  }
}

async function admin(b: Backend, path: string) {
  const r = await fetch(`${b.url}${path}`, {
    headers: { authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}` },
  });
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: r.status, body };
}

async function mutate(b: Backend, path: string, args: unknown = {}) {
  const r = await b.call("mutation", path, args);
  if (!r.ok) throw new Error(`${b.name} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
}

/** A query's value, or the first line of its error without the request id. */
async function read(b: Backend, path: string, args: unknown) {
  const r = await b.call("query", path, args);
  return r.ok
    ? (r.body as { value: unknown }).value
    : String((r.body as { errorMessage?: string }).errorMessage ?? r.body)
        .split("\n")[0]!
        .replace(/^\[Request ID: [^\]]*\] /, "");
}

/** What an app sees of the active schemas: `get_schema`, a record table's JSON Schema, a query by each index. */
async function observe(b: Backend) {
  const schema = await admin(b, "/api/streaming_import/get_schema");
  const exported = await admin(b, "/api/json_schemas");
  return {
    getSchema: schema.status === 200 ? (schema.body === null ? null : "a schema") : schema,
    jsonSchemas:
      exported.status === 200
        ? "ok"
        : { status: exported.status, code: (exported.body as { code?: string } | null)?.code ?? exported.body },
    byIndex: await read(b, "data:byN", { n: 1 }),
    componentByIndex: await read(b, "store:byK", { k: "a" }),
  };
}

async function deployments(start: typeof startConvex) {
  const store = newStore();
  let project = "";
  let dir = "";
  try {
    const b = await start({
      store,
      app: APP,
      prepare: (p, d) => {
        project = p;
        dir = d;
        prepareComponent(p, d);
      },
    });
    const appSchema = join(project, dir, "schema.ts");
    const kvSchema = join(project, dir, "kv", "schema.ts");
    const sources = { app: readFileSync(appSchema, "utf8"), kv: readFileSync(kvSchema, "utf8") };
    const deploy = () => b.cli(["deploy", "--yes", "--typecheck=disable"]);
    await mutate(b, "data:add", { n: 1 });
    await mutate(b, "data:addWide");
    await mutate(b, "store:put", { k: "a" });
    const withSchemas = await observe(b);
    rmSync(appSchema);
    await deploy();
    const withoutApp = await observe(b);
    await deploy();
    const withoutAppAgain = await observe(b);
    writeFileSync(appSchema, sources.app);
    rmSync(kvSchema);
    await deploy();
    const withoutComponent = await observe(b);
    writeFileSync(kvSchema, sources.kv);
    await deploy();
    const back = await observe(b);
    await b.stop();
    return {
      withSchemas,
      withoutApp,
      withoutAppAgain,
      withoutComponent,
      back,
      rows: schemaRows(join(store.dir, "store.sqlite3")),
    };
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
}

describe.skipIf(!ready)("a push without a schema (Convex's `SchemaModel::apply(None)`)", () => {
  test("the active schema is overwritten and none replaces it, as Convex's", async () => {
    const convex = await deployments(startConvex);
    const bunvex = await deployments(startBunvex);
    expect(bunvex).toEqual(convex);
  }, 300_000);
});

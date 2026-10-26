// The `_schemas` rows a deployment keeps (STUDY-187 X3): each deploy that changes the schema marks the previous
// active one `overwritten` (Convex's `clear_active`), and a schema the documents do not match stays `failed`; each
// backend's rows are read straight from its SQLite store and compared, by creation time. Rows older than an hour go
// (`delete_old_failed_and_overwritten_schemas`); a test cannot wait that long on a binary, so the hour is checked by
// packages/core/test/schemas-overwritten.test.ts. Local only: skipped, with a note, when Convex's backend is not
// there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, newStore, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`schemas-overwritten: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../schemas-overwritten-app");
/** A schema of `items` whose `n` is `type`, and the tables in `extra`, for the CLI of `dir`. */
const schemaSource = (dir: string, type: string, extra: string[] = []) =>
  `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({ n: v.${type}() }),
${extra.map((t) => `  ${t}: defineTable({}),\n`).join("")}});
`.replaceAll('"convex/', `"${dir}/`);

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
      .sort((a, b) => (a._creationTime as number) - (b._creationTime as number));
  } finally {
    db.close();
  }
}

/** Each row's state and the tables of its schema, with a failed one's table. */
const summary = (rows: Json[]) =>
  rows.map((r) => {
    const state = r.state as { state: string; table_name?: string | null };
    const tables = (JSON.parse(r.schema as string) as { tables: { tableName: string }[] }).tables.map(
      (t) => t.tableName,
    );
    return { state: state.state, ...(state.state === "failed" ? { table: state.table_name } : {}), tables };
  });

async function deployments(start: typeof startConvex) {
  const store = newStore();
  let project = "";
  let dir = "";
  try {
    const b: Backend = await start({
      store,
      app: APP,
      prepare: (p, d) => {
        project = p;
        dir = d;
      },
    });
    const deploy = async (type: string, extra: string[] = []) => {
      writeFileSync(join(project, dir, "schema.ts"), schemaSource(dir, type, extra));
      return b.cli(["deploy", "--yes", "--typecheck=disable"]).then(
        () => "deployed",
        () => "refused",
      );
    };
    const r = await b.call("mutation", "items:add", { n: 1 });
    if (!r.ok) throw new Error(`${b.name} items:add: ${JSON.stringify(r.body)}`);
    const outcomes = [
      await deploy("number", ["second"]),
      // `n` holds a number: this one fails.
      await deploy("string", ["third"]),
      await deploy("number", ["fourth"]),
      // The active schema again: no new row.
      await deploy("number", ["fourth"]),
    ];
    await b.stop();
    return { outcomes, rows: summary(schemaRows(join(store.dir, "store.sqlite3"))) };
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
}

describe.skipIf(!ready)("the `_schemas` rows after several deploys (STUDY-187 X3)", () => {
  test("the replaced schemas kept as overwritten, the failed one as failed, as Convex's", async () => {
    const convex = await deployments(startConvex);
    expect(convex).toEqual({
      outcomes: ["deployed", "refused", "deployed", "deployed"],
      rows: [
        { state: "overwritten", tables: ["items"] },
        { state: "overwritten", tables: ["items", "second"] },
        { state: "failed", table: "items", tables: ["items", "third"] },
        { state: "active", tables: ["fourth", "items"] },
      ],
    });
    const bunvex = await deployments(startBunvex);
    expect(bunvex).toEqual(convex);
  }, 300_000);
});

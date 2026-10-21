// The table numbers a push gives new tables (STUDY-161 §7), on Convex's backend (the oracle) and on bunvex's: the
// app of `push-order-app/` (tables with a database, staged, search or vector index, and without, mixed case, in no
// order) deployed by each CLI, then a second push with new tables and a new index on a table that exists. The two
// `_system/frontend/getTableMapping` answers must be equal after each push. Local only: skipped, with a note, when
// Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`push-table-numbers: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../push-order-app");
const projects: Record<string, string> = {};
let convex: Backend;
let bunvex: Backend;

const mapping = async (b: Backend) => {
  const r = await fetch(`${b.url}/api/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`,
    },
    body: JSON.stringify({ path: "_system/frontend/getTableMapping", args: {}, format: "json" }),
  });
  return ((await r.json()) as { value: Record<string, string> }).value;
};

describe.skipIf(!ready)("a push's table numbers on Convex and on bunvex", () => {
  beforeAll(async () => {
    const prepare = (project: string, dir: "convex" | "bunvex") => {
      projects[dir] = join(project, dir);
    };
    [convex, bunvex] = await startAll([startConvex({ app: APP, prepare }), startBunvex({ app: APP, prepare })]);
  }, 300_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("the first push: tables with an index by name, then the others by name", async () => {
    const [c, b] = await Promise.all([mapping(convex), mapping(bunvex)]);
    expect(b).toEqual(c);
    // what the comparison stands on
    expect(c["10001"]).toBe("free");
    expect(c["10005"]).toBe("Beta");
  });

  test("a second push: the tables that exist keep their numbers, the new ones follow the same rule", async () => {
    for (const dir of ["convex", "bunvex"] as const) {
      const file = join(projects[dir]!, "schema.ts");
      const added = [
        '  apple: defineTable(v.any()).index("by_x", ["x"]),',
        '  yak: defineTable(v.any()).index("by_y", ["y"]),',
        "  Cat: defineTable(v.any()),",
        '  bee: defineTable(v.any()).searchIndex("s", { searchField: "b" }),',
        "  ant: defineTable(v.any()),",
      ].join("\n");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("  apple: defineTable(v.any()),\n", "").replace("});\n", `${added}\n});\n`),
      );
    }
    await Promise.all([
      convex.cli(["deploy", "--yes", "--typecheck=disable"]),
      bunvex.cli(["deploy", "--typecheck=disable"]),
    ]);
    const [c, b] = await Promise.all([mapping(convex), mapping(bunvex)]);
    expect(b).toEqual(c);
    expect(c["10008"]).toBe("apple");
    expect([c["10011"], c["10012"], c["10013"], c["10014"]]).toEqual(["bee", "yak", "Cat", "ant"]);
  }, 300_000);
});

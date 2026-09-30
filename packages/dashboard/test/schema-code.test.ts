import { describe, expect, test } from "bun:test";
import type { IndexInfo, SchemaInfo, TableInfo } from "../src/data-source.ts";
import { schemaCode } from "../src/database/schema-code.ts";

const SYS: IndexInfo[] = [
  { name: "by_id", fields: ["_id"], system: true, state: "ready" },
  { name: "by_creation_time", fields: ["_creationTime"], system: true, state: "ready" },
];
const table = (name: string, ...indexes: [string, string[]][]): TableInfo => ({
  name,
  declared: true,
  indexes: [...SYS, ...indexes.map(([n, fields]) => ({ name: n, fields, system: false, state: "ready" as const }))],
});

describe("the saved schema as code", () => {
  const tables = [table("tasks", ["by_owner", ["owner", "_creationTime"]]), table("users")];

  test("validated (the default): defineSchema({ … }), fields, indexes without system fields", () => {
    const schema: SchemaInfo = {
      enforced: true,
      tables: [
        { name: "users" },
        {
          name: "tasks",
          validator: {
            type: "object",
            value: {
              text: { fieldType: { type: "string" }, optional: false },
              owner: { fieldType: { type: "id", tableName: "users" }, optional: true },
            },
          },
        },
      ],
    };
    const r = schemaCode(schema, tables)!;
    expect(r.code).toBe(
      [
        'import { defineSchema, defineTable } from "bunvex/server";',
        'import { v } from "bunvex/values";',
        "",
        "export default defineSchema({",
        '  tasks: defineTable({ text: v.string(), owner: v.optional(v.id("users")) }).index("by_owner", ["owner"]),',
        "  users: defineTable(v.any()),",
        "});",
      ].join("\n"),
    );
    expect(r.lines.get("tasks")).toEqual({ from: 5, to: 5 });
    expect(r.lines.get("users")).toEqual({ from: 6, to: 6 });
  });

  test("not validated: the option, the tables one level in; a wide type over several lines", () => {
    const wide = Object.fromEntries(
      ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map((k) => [
        k,
        { fieldType: { type: "string" as const }, optional: false },
      ]),
    );
    const r = schemaCode(
      { enforced: false, tables: [{ name: "tasks", validator: { type: "object", value: wide } }] },
      tables,
    )!;
    const lines = r.code.split("\n");
    expect(lines.slice(3, 5)).toEqual(["export default defineSchema(", "  {"]);
    expect(lines[5]).toBe("    tasks: defineTable({");
    expect(lines.at(-3)).toBe("  },");
    expect(lines.at(-2)).toBe("  { schemaValidation: false },");
    expect(r.lines.get("tasks")).toEqual({ from: 6, to: 13 });
    expect(lines[12]).toBe('    }).index("by_owner", ["owner"]),');
  });

  test("a union document type stays a validator; nothing declared is no schema", () => {
    const r = schemaCode(
      { enforced: true, tables: [{ name: "users", validator: { type: "union", value: [{ type: "null" }] } }] },
      tables,
    )!;
    expect(r.code).toContain("users: defineTable(v.union(v.null())),");
    expect(schemaCode({ enforced: true, tables: [] }, tables)).toBeNull();
  });
});

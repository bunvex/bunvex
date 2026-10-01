import { describe, expect, test } from "bun:test";
import type { SchemaInfo, TableInfo, ValidatorJson } from "../src/data-source.ts";
import { encodeInt64 } from "../src/filters.ts";
import { computeClusters } from "../src/schema/clusters.ts";
import { buildSchemaGraph, typeLabel } from "../src/schema/graph.ts";
import { computeLayout } from "../src/schema/layout.ts";

const v = {
  string: (): ValidatorJson => ({ type: "string" }),
  number: (): ValidatorJson => ({ type: "number" }),
  id: (tableName: string): ValidatorJson => ({ type: "id", tableName }),
  literal: (value: string): ValidatorJson => ({ type: "literal", value }),
  array: (value: ValidatorJson): ValidatorJson => ({ type: "array", value }),
  union: (...value: ValidatorJson[]): ValidatorJson => ({ type: "union", value }),
  object: (fields: Record<string, ValidatorJson>, optional: string[] = []): ValidatorJson => ({
    type: "object",
    value: Object.fromEntries(
      Object.entries(fields).map(([k, f]) => [k, { fieldType: f, optional: optional.includes(k) }]),
    ),
  }),
};
const table = (name: string, extra: Partial<TableInfo> = {}): TableInfo => ({
  name,
  indexes: [],
  declared: true,
  ...extra,
});

describe("the schema graph", () => {
  test("types read as TypeScript: compact in a node, spelled out on request", () => {
    expect(typeLabel(v.id("users"))).toBe('Id<"users">');
    expect(typeLabel(v.array(v.union(v.string(), v.number())))).toBe("(string | number)[]");
    expect(typeLabel({ type: "literal", value: encodeInt64(5n) })).toBe("5n");
    expect(typeLabel({ type: "bytes" })).toBe("ArrayBuffer");
    const obj = v.object({ theme: v.union(v.literal("light"), v.literal("dark")), "x-y": v.number() }, ["x-y"]);
    expect(typeLabel(obj)).toBe("{ … }");
    expect(typeLabel(obj, true)).toBe('{ theme: "light" | "dark"; "x-y"?: number }');
    expect(typeLabel({ type: "record", keys: v.string(), values: { fieldType: v.id("tags"), optional: false } })).toBe(
      'Record<string, Id<"tags">>',
    );
  });

  test("an edge for every reference, nested ones too; none to a table that is not there", () => {
    const schema: SchemaInfo = {
      enforced: true,
      tables: [
        { name: "users", validator: v.object({ name: v.string() }) },
        {
          name: "tasks",
          validator: v.object(
            {
              owner: v.id("users"),
              tags: v.array(v.id("tags")),
              meta: v.object({ reviewer: v.id("users") }),
              gone: v.id("nowhere"),
            },
            ["meta"],
          ),
        },
        { name: "tags" },
      ],
    };
    const g = buildSchemaGraph(schema, [table("users"), table("tasks"), table("tags")])!;
    expect(g.nodes.map((n) => n.table)).toEqual(["tags", "tasks", "users"]);
    expect(g.edges.map((e) => `${e.source}.${e.field}->${e.target}${e.optional ? "?" : ""}`).sort()).toEqual([
      "tasks.meta->users?",
      "tasks.owner->users",
      "tasks.tags->tags",
    ]);
    const tasks = g.nodes.find((n) => n.table === "tasks")!;
    expect(tasks.fields.find((f) => f.name === "meta")).toMatchObject({
      type: "{ … }",
      fullType: '{ reviewer: Id<"users"> }',
    });
    expect(g.nodes.find((n) => n.table === "tags")!.untyped).toBe(true);
  });

  test("a union document type: merged fields, its members, the discriminator first", () => {
    const schema: SchemaInfo = {
      enforced: false,
      tables: [
        {
          name: "events",
          validator: v.union(
            v.object({ kind: v.literal("click"), x: v.number(), by: v.id("users") }),
            v.object({ kind: v.literal("key"), key: v.string(), by: v.id("users") }),
          ),
        },
        { name: "users", validator: v.object({}) },
      ],
    };
    const n = buildSchemaGraph(schema, [])!.nodes.find((x) => x.table === "events")!;
    expect(n.union?.discriminator).toBe("kind");
    expect(n.union?.variants.map((x) => x.label)).toEqual(['"click"', '"key"']);
    expect(n.fields.map((f) => `${f.name}${f.optional ? "?" : ""}: ${f.type}`)).toEqual([
      'kind: "click" | "key"',
      "x?: number",
      'by: Id<"users">',
      "key?: string",
    ]);
  });

  test("an undeclared table joins, flagged, typed from its documents; no schema: every table inferred", () => {
    const schema: SchemaInfo = { enforced: false, tables: [{ name: "users", validator: v.object({}) }] };
    const g = buildSchemaGraph(schema, [table("users"), table("imports", { declared: false, documentCount: 3 })], {
      imports: v.object({ by: v.id("users") }),
    })!;
    expect(g.nodes.find((n) => n.table === "imports")).toMatchObject({ notInSchema: true, documentCount: 3 });
    expect(g.edges.map((e) => e.id)).toEqual(["imports.by->users"]);
    const none = buildSchemaGraph({ enforced: false, tables: [] }, [table("a"), table("b")], {
      a: v.object({ b: v.id("b") }),
    })!;
    expect(none.nodes.every((n) => !n.notInSchema)).toBe(true);
    expect(none.edges).toHaveLength(1);
    expect(buildSchemaGraph({ enforced: false, tables: [] }, [])).toBeNull();
  });
});

describe("groups and layout", () => {
  const chain = (names: string[], extra: [string, string][] = []): SchemaInfo => ({
    enforced: false,
    tables: names.map((name, i) => {
      const refs: Record<string, ValidatorJson> = {};
      if (i > 0) refs.prev = v.id(names[i - 1]!);
      for (const [from, to] of extra) if (from === name) refs[`to_${to}`] = v.id(to);
      return { name, validator: v.object(refs) };
    }),
  });

  test("linked tables form a group named after the most linked one; a lone table forms none", () => {
    const schema = chain(["a", "b", "c"], [["c", "b"]]);
    schema.tables.push({ name: "solo", validator: v.object({}) });
    const clusters = computeClusters(buildSchemaGraph(schema, [])!);
    expect(clusters).toEqual([{ id: "cluster:a,b,c", label: "b", tables: ["a", "b", "c"] }]);
  });

  test("a large linked group splits into its dense parts", () => {
    // two cliques of five, joined by one edge
    const clique = (names: string[]) =>
      names.flatMap((a, i) => names.slice(i + 1).map((b) => [a, b] as [string, string]));
    const left = ["l1", "l2", "l3", "l4", "l5"];
    const right = ["r1", "r2", "r3", "r4", "r5"];
    const schema: SchemaInfo = {
      enforced: false,
      tables: [...left, ...right].map((name) => ({ name, validator: v.object({}) })),
    };
    for (const [a, b] of [...clique(left), ...clique(right), ["l1", "r1"] as [string, string]]) {
      const t = schema.tables.find((x) => x.name === a)!;
      (t.validator as Extract<ValidatorJson, { type: "object" }>).value[`to_${b}`] = {
        fieldType: v.id(b),
        optional: false,
      };
    }
    const clusters = computeClusters(buildSchemaGraph(schema, [])!);
    expect(clusters.map((c) => c.tables)).toEqual([left, right]);
  });

  test("every table gets a box; a group's box holds its tables", async () => {
    const schema = chain(["a", "b", "c"]);
    schema.tables.push({ name: "solo", validator: v.object({}) });
    const g = buildSchemaGraph(schema, [])!;
    const clusters = computeClusters(g);
    const layout = await computeLayout(g, clusters);
    expect(Object.keys(layout.nodes).sort()).toEqual(["a", "b", "c", "solo"]);
    const box = layout.clusters[clusters[0]!.id]!;
    for (const t of ["a", "b", "c"]) {
      const n = layout.nodes[t]!;
      expect(
        n.x >= box.x && n.y >= box.y && n.x + n.width <= box.x + box.width && n.y + n.height <= box.y + box.height,
      ).toBe(true);
    }
    // top to bottom: a table is drawn below the one it points at… or above; either way the layers differ
    expect(new Set(["a", "b", "c"].map((t) => layout.nodes[t]!.y)).size).toBe(3);
  });
});

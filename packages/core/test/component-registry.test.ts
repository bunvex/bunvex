// The component registry (STUDY-152 step 2): `_components` rows in Convex's shape, paths resolved through the tree,
// and a new component's namespace. Convex's rows are convex-rows/components.json; the store is component-store.ts's:
// a root with `counter` and `second`, both instances of one `counter` definition.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeId } from "@bunvex/values";
import { SYSTEM_TABLE_NUMBERS } from "../src/catalog.ts";
import {
  allComponentPaths,
  COMPONENT_NAMESPACE_TABLES,
  ComponentMetadataError,
  componentChildren,
  componentDefinitionMeta,
  componentDefinitionRow,
  componentInParent,
  componentMeta,
  componentPath,
  componentRow,
  resolveComponentPath,
  rootComponent,
} from "../src/components.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { buildComponentStore, rootSchema } from "./component-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** Convex's rows (convex-rows/components.json). */
const convex = JSON.parse(readFileSync(join(import.meta.dir, "convex-rows/components.json"), "utf8")) as {
  _components: Record<string, unknown>[];
  componentNamespace: Record<string, { number: number; indexes: Record<string, string[]> }>;
};
/** Convex's rows with env bindings, declared env vars and an HTTP mount (convex-rows/component-definitions.json). */
const withEnv = JSON.parse(readFileSync(join(import.meta.dir, "convex-rows/component-definitions.json"), "utf8")) as {
  _component_definitions: Record<string, unknown>[];
  _components: Record<string, unknown>[];
};
const convexDefinitions = JSON.parse(readFileSync(join(import.meta.dir, "convex-rows/components.json"), "utf8"))
  ._component_definitions as Record<string, unknown>[];
const unstamped = (row: Record<string, unknown>) => {
  const { _id: _, _creationTime: __, ...stored } = row;
  return stored;
};
/** The store with components (component-store.ts), opened. */
async function openStore(): Promise<Engine> {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-component-registry-"));
  dirs.push(dir);
  const { path } = await buildComponentStore(join(dir, "log"));
  return await new Engine(rootSchema, await MemoryPersistence.open(path, { durable: false })).init();
}
const rows = async (e: Engine) =>
  (await e.query((db) => db.asSystem(() => db.query("_components").collect()))) as Record<string, unknown>[];

describe("_components rows", () => {
  test("Convex's rows read back and write out as they are", () => {
    for (const row of [...convex._components, ...withEnv._components]) {
      const { _id: _, _creationTime: __, ...stored } = row;
      expect(componentRow(componentMeta(row))).toEqual(stored);
    }
  });

  test("args and env are written by key, as Convex's maps", () => {
    const row = componentRow({
      definitionId: "d",
      parent: "p",
      name: "counter",
      args: [],
      env: [
        ["MODE", { type: "value", value: "b" }],
        ["KEY", { type: "envVar", name: "ZETA" }],
      ],
      state: "active",
      httpPrefix: "/c/",
    });
    expect(row).toEqual(
      unstamped({ ...withEnv._components.find((r) => r.name === "counter")!, definitionId: "d", parent: "p" }),
    );
  });

  test("bunvex's rows are Convex's", async () => {
    const e = await openStore();
    try {
      const strip = (r: Record<string, unknown>) => {
        const { _id: _, _creationTime: __, definitionId: ___, parent: ____, ...rest } = r;
        return rest;
      };
      const byName = (rs: Record<string, unknown>[]) => Object.fromEntries(rs.map((r) => [String(r.name), strip(r)]));
      expect(byName(await rows(e))).toEqual(byName(convex._components));
    } finally {
      await e.close();
    }
  });

  test("a row Convex cannot load is refused, in its words", () => {
    const base = { _id: "x", definitionId: "d", httpPrefix: null };
    expect(() => componentMeta({ ...base, parent: null, name: null, args: null, state: "gone" })).toThrow(
      new ComponentMetadataError("Invalid component state: gone"),
    );
    expect(() => componentMeta({ ...base, parent: "p", name: null, args: [], state: "active" })).toThrow(
      "Invalid component type",
    );
    // No state is active; a child without env has none.
    expect(componentMeta({ ...base, parent: "p", name: "n", args: [] })).toMatchObject({ state: "active", env: [] });
  });
});

describe("the tree", () => {
  test("paths and ids, both ways", async () => {
    const e = await openStore();
    try {
      // A `_components` id no row has.
      const absent = await e.mutation((db) => db.asSystem(async () => db.newId("_components")));
      await e.query(async (db) => {
        const root = (await rootComponent(db))!;
        expect(root.parent).toBeNull();
        const counter = (await componentInParent(db, root._id, "counter"))!;
        const second = (await componentInParent(db, root._id, "second"))!;
        expect(counter.definitionId).toBe(second.definitionId);
        expect((await componentChildren(db, root._id)).map((c) => c.name).sort()).toEqual(["counter", "second"]);
        expect(await componentChildren(db, counter._id)).toEqual([]);
        expect(await componentPath(db, counter._id)).toEqual(["counter"]);
        expect(await componentPath(db, root._id)).toEqual([]);
        expect(await componentPath(db, absent)).toBeNull();
        expect((await resolveComponentPath(db, ["second"]))?._id).toBe(second._id);
        expect((await resolveComponentPath(db, []))?._id).toBe(root._id);
        expect(await resolveComponentPath(db, ["nope"])).toBeNull();
        expect(await resolveComponentPath(db, ["counter", "inner"])).toBeNull();
        expect(await allComponentPaths(db)).toEqual(
          new Map<string | null, string[]>([
            [counter._id, ["counter"]],
            [second._id, ["second"]],
            [null, []],
          ]),
        );
      });
    } finally {
      await e.close();
    }
  });

  test("a path resolved in a query is a read: changing the tree invalidates it, another table's write does not", async () => {
    const e = await openStore();
    try {
      const r = await e.queryTracked((db) => resolveComponentPath(db, ["counter"]));
      expect(r.ok && r.value?.name).toBe("counter");
      await e.mutation((db) => db.insert("messages", { text: "x" }));
      expect(e.committer.changedBetween(r.reads, r.ts, e.committer.visibleTs)).toBe(false);
      await e.mutation((db) =>
        db.asSystem(async () => {
          const counter = (await resolveComponentPath(db, ["counter"]))!;
          await db.patch("_components", counter._id, { state: "unmounted" });
        }),
      );
      expect(e.committer.changedBetween(r.reads, r.ts, e.committer.visibleTs)).toBe(true);
    } finally {
      await e.close();
    }
  });

  test("a nested path, and a row whose chain to the root is broken", async () => {
    const e = await new Engine(rootSchema, await MemoryPersistence.open(null, { durable: false })).init();
    try {
      const ids = await e.mutation((db) =>
        db.asSystem(async () => {
          const row = (parent: string | null, name: string | null) =>
            componentRow(
              parent === null
                ? { definitionId: "d", parent: null, name: null, state: "active", httpPrefix: null }
                : { definitionId: "d", parent, name: name!, args: [], env: [], state: "active", httpPrefix: null },
            );
          const root = await db.insert("_components", row(null, null));
          const a = await db.insert("_components", row(root, "a"));
          const b = await db.insert("_components", row(a, "b"));
          const orphan = await db.insert("_components", row(db.newId("_components"), "lost"));
          return { root, a, b, orphan };
        }),
      );
      await e.query(async (db) => {
        expect(await componentPath(db, ids.b)).toEqual(["a", "b"]);
        expect((await resolveComponentPath(db, ["a", "b"]))?._id).toBe(ids.b);
        expect(await resolveComponentPath(db, ["b"])).toBeNull();
        expect(await componentPath(db, ids.orphan)).toBeNull();
        expect(await allComponentPaths(db)).toEqual(
          new Map<string | null, string[]>([
            [ids.a, ["a"]],
            [ids.b, ["a", "b"]],
            [null, []],
          ]),
        );
      });
    } finally {
      await e.close();
    }
  });

  test("a store no push wrote a root to has only the root's path", async () => {
    const e = await new Engine(rootSchema, await MemoryPersistence.open(null, { durable: false })).init();
    try {
      await e.query(async (db) => {
        expect(await rootComponent(db)).toBeNull();
        expect(await resolveComponentPath(db, ["a"])).toBeNull();
        expect(await allComponentPaths(db)).toEqual(new Map([[null, []]]));
      });
    } finally {
      await e.close();
    }
  });
});

describe("a new component's namespace", () => {
  test("its system tables and indexes are a Convex component's", async () => {
    const expected = convex.componentNamespace;
    expect(Object.keys(expected).sort()).toEqual([...COMPONENT_NAMESPACE_TABLES].sort());

    const path = join(mkdtempSync(join(tmpdir(), "bunvex-component-ns-")), "log");
    dirs.push(join(path, ".."));
    const e = await new Engine(rootSchema, await MemoryPersistence.open(path, { durable: false })).init();
    const rootNumbers = Object.fromEntries([...e.catalog.tables.values()].map((t) => [t.name, t.number]));
    const id = await e.initializeComponentNamespace();
    try {
      // A `_components` id, though no row has it yet.
      expect(decodeId(id).tableNumber).toBe(SYSTEM_TABLE_NUMBERS._components);
      expect((await rows(e)).some((r) => r._id === id)).toBe(false);
      const ns = e.catalog.components.get(id)!;
      const actual = Object.fromEntries(
        [...ns.tables.values()].map((t) => [
          t.name,
          { number: t.number, indexes: Object.fromEntries([...t.indexes].map(([n, i]) => [n, i.fields])) },
        ]),
      );
      expect(actual).toEqual(expected);
      // The root's tables are untouched.
      expect(Object.fromEntries([...e.catalog.tables.values()].map((t) => [t.name, t.number]))).toEqual(rootNumbers);
    } finally {
      await e.close();
    }
    // Stored: a restart finds the namespace.
    const again = await new Engine(rootSchema, await MemoryPersistence.open(path, { durable: false })).init();
    try {
      expect([...again.catalog.components.get(id)!.tables.keys()].sort()).toEqual(
        [...COMPONENT_NAMESPACE_TABLES].sort(),
      );
    } finally {
      await again.close();
    }
  });

  test("an id is reserved only by the system", async () => {
    const e = await new Engine(rootSchema, await MemoryPersistence.open(null, { durable: false })).init();
    try {
      await expect(e.mutation(async (db) => db.newId("_components"))).rejects.toThrow(
        "newId is for system transactions",
      );
    } finally {
      await e.close();
    }
  });
});

describe("_component_definitions rows", () => {
  test("Convex's rows read back and write out as they are: tagged children, null envVars, maps by key", () => {
    for (const row of [...convexDefinitions, ...withEnv._component_definitions])
      expect(componentDefinitionRow(componentDefinitionMeta(row))).toEqual(unstamped(row));
    const app = componentDefinitionMeta(withEnv._component_definitions.find((r) => r.path === "")!);
    expect(app).toMatchObject({
      definitionType: { type: "app" },
      httpMounts: { "/c/": "_reference/childComponent/counter" },
      envVars: [
        ["ALPHA", { type: "value", value: '{"type":"string"}', optional: true }],
        ["ZETA", { type: "value", value: '{"type":"string"}' }],
      ],
    });
    expect(app.childComponents.map((c) => c.name)).toEqual(["counter", "second"]);
  });

  test("a definition as a push gives it (declaration order) is written by key, as Convex's", () => {
    const stored = withEnv._component_definitions.find((r) => r.path === "")!;
    const row = componentDefinitionRow({
      path: "",
      definitionType: { type: "app" },
      childComponents: [
        {
          name: "counter",
          path: "counter",
          args: [],
          env: [
            ["MODE", { type: "value", value: "b" }],
            ["KEY", { type: "envVar", name: "ZETA" }],
          ],
        },
        { name: "second", path: "counter", args: [], env: [["MODE", { type: "value", value: "a" }]] },
      ],
      httpMounts: { "/c/": "_reference/childComponent/counter" },
      httpPrefix: null,
      exports: { type: "branch", branch: [] },
      envVars: [
        ["ZETA", { type: "value", value: '{"type":"string"}' }],
        ["ALPHA", { type: "value", value: '{"type":"string"}', optional: true }],
      ],
    });
    expect(row).toEqual(unstamped(stored));
    // Children keep their order (Convex's `Vec`); a branch's exports are by key, as every map.
    const exports = componentDefinitionRow({
      ...componentDefinitionMeta(stored),
      exports: {
        type: "branch",
        branch: [
          ["b", { type: "leaf", leaf: "_reference/function/b" }],
          [
            "a",
            {
              type: "branch",
              branch: [
                ["z", { type: "leaf", leaf: "z" }],
                ["y", { type: "leaf", leaf: "y" }],
              ],
            },
          ],
        ],
      },
    }).exports;
    expect(exports).toEqual({
      type: "branch",
      branch: [
        [
          "a",
          {
            type: "branch",
            branch: [
              ["y", { type: "leaf", leaf: "y" }],
              ["z", { type: "leaf", leaf: "z" }],
            ],
          },
        ],
        ["b", { type: "leaf", leaf: "_reference/function/b" }],
      ],
    });
  });

  test("a row Convex could not load is refused", () => {
    const good = unstamped(convexDefinitions[0]!);
    for (const [field, value] of [
      ["path", 1],
      ["definitionType", { type: "other" }],
      ["childComponents", [{ name: "x" }]],
      ["httpMounts", { "/no-slash": "_reference/childComponent/x" }],
      ["httpPrefix", "/a*/"],
      ["exports", { type: "leaf", leaf: "x" }],
      ["envVars", [["X"]]],
    ] as const)
      expect(() => componentDefinitionMeta({ ...good, [field]: value })).toThrow(
        new ComponentMetadataError(`Invalid component definition: ${field}`),
      );
  });
});

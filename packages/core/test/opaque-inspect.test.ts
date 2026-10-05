// Engine objects print as `Name {…}` under every inspector (inspect.ts): `Bun.inspect`, `util.inspect`, and
// so object-inspect, which defers to the same hook (the server's console capture, logs.ts). And no class an
// app can reach is left out, today or later.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { defineSchema, defineTable, Engine, opaqueToInspect } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";

test("an engine, its store and a transaction print by name under Bun.inspect and util.inspect", async () => {
  const persistence = await MemoryPersistence.open(null, { durable: false });
  const engine = await new Engine(defineSchema({ t: defineTable(v.any()) }), persistence).init();
  await engine.mutation(async (db) => {
    for (const [value, name] of [
      [engine, "Engine"],
      [persistence, "MemoryPersistence"],
      [db, "Tx"],
      [db.query("t"), "QueryInitializerImpl"],
      [db.query("t").order("asc"), "QueryImpl"],
      [db.system, "SystemReader"],
      [db.table("t"), "TableWriter"],
    ] as const) {
      expect(Bun.inspect(value)).toBe(`${name} {…}`);
      expect(inspect(value)).toBe(`${name} {…}`);
      expect(inspect({ inside: [value] }, { depth: 10 })).toBe(`{ inside: [ ${name} {…} ] }`);
    }
  });
});

test("the name comes from the prototype: a Proxy's traps never run, a subclass keeps its own name", () => {
  class Base {
    secret = "s3cr3t";
  }
  class Derived extends Base {}
  opaqueToInspect(Base);
  let trapped = 0;
  const proxy = new Proxy(new Derived(), {
    get(target, prop) {
      if (typeof prop === "string") trapped++;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(Bun.inspect(new Derived())).toBe("Derived {…}");
  expect(Bun.inspect(proxy)).toBe("Derived {…}");
  expect(trapped).toBe(0);
});

// Every class declared where an app's objects come from — `ctx.db`, `ctx.db.system`, a query, a table
// scope — is opaque, except the errors (an app catches them: name and message, as Convex's) and the two
// builders whose only state is the app's own arguments (Convex prints its builders' expressions too).
const APP_REACHABLE = ["tx.ts", "system-reader.ts", "table-scope.ts", "query-ops.ts"];
const APP_DATA_ONLY = new Set(["IndexRangeBuilder", "SearchFilterBuilder"]);

test("no class an app can reach is left out (a new one must be made opaque, or listed here with a reason)", () => {
  for (const file of APP_REACHABLE) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    const opaque = new Set(
      [...source.matchAll(/opaqueToInspect\(([^)]*)\)/g)].flatMap((m) => m[1]!.split(",").map((s) => s.trim())),
    );
    for (const [, name, parent] of source.matchAll(/^(?:export )?class (\w+)(?:<[^>]*>)?(?: extends (\w+))?/gm)) {
      if (parent?.endsWith("Error") || APP_DATA_ONLY.has(name!)) continue;
      expect({ file, name, opaque: opaque.has(name!) || opaque.has(parent!) }).toEqual({ file, name, opaque: true });
    }
  }
});

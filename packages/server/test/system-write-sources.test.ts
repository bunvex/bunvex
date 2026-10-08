// Every write bunvex makes on its own carries a source under `_system/` (DV-435): an OCC conflict it causes then
// reads as Convex's description of the writer ("A system operation", "A data import", …), never `A call to
// "<internal label>"`. The labels are literals at the call sites; this finds any left without the prefix.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const roots = [join(import.meta.dir, "../src"), join(import.meta.dir, "../../core/src")];
// `engine.mutation(body, "label")`, `host.system(body, "label")` and `runMutation(body, true, "label")`.
const patterns = [/\},\s*"([a-z][a-z0-9_]*)"\s*\)/g, /\b(?:true|false),\s*"([a-z][a-z0-9_]*)",?\s*\)/g];
// Literals the patterns catch that are not write sources: index orders, and a commit listener's name.
const notSources = new Set(["asc", "desc", "scheduler"]);

test("every internal write source is under `_system/` (DV-435)", () => {
  const bare: string[] = [];
  for (const root of roots)
    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      if (!file.endsWith(".ts")) continue;
      const text = readFileSync(join(root, file), "utf8");
      for (const re of patterns)
        for (const m of text.matchAll(re)) if (!notSources.has(m[1]!)) bare.push(`${file}: "${m[1]}"`);
    }
  expect(bare).toEqual([]);
});

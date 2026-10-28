// The names `bunvex/server` and `bunvex/values` export, against Convex's (STUDY-180 §3.2): every name the installed
// `convex` 1.48.0 exports from `convex/server` and `convex/values` (its `.d.ts`, as the type checker sees them,
// values and types together) is exported by bunvex's entry under the same name, except the ones listed here. The
// `convex` package is the differential suite's dev dependency (packages/differential): read from its `.d.ts`
// files, not imported. The shapes are compared by packages/differential/test/api-shapes.test.ts and
// test/types/api-names.test.ts.
import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import ts from "typescript";

/** Convex's names bunvex does not export, each with why. */
const NOT_EXPORTED: Record<"server" | "values", Record<string, string>> = {
  server: {
    // DV-543: deprecated in Convex, kept there for older clients.
    StorageId: "DV-543",
    FileStorageId: "DV-543",
    FileMetadata: "DV-543",
    ValidatedFunction: "DV-543",
    UnvalidatedFunction: "DV-543",
  },
  values: {
    // Rule 5 (DV-312): bunvex's names for them are `BunvexError`, `toJsonValue`, `fromJsonValue`, `valueSize`.
    ConvexError: "DV-312",
    convexToJson: "DV-312",
    jsonToConvex: "DV-312",
    getConvexSize: "DV-312",
  },
};

const differential = resolve(import.meta.dir, "../../differential");
const reference = dirname(Bun.resolveSync("convex/package.json", differential));
const version = (await Bun.file(resolve(reference, "package.json")).json()).version as string;

/** The names a module exports, as the type checker lists them (values and types). */
function exportedNames(file: string): Set<string> {
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`${file} was not read`);
  const module = checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`${file} is not a module`);
  return new Set(checker.getExportsOfModule(module).map((s) => s.name));
}

const ENTRIES = {
  server: {
    reference: resolve(reference, "dist/esm-types/server/index.d.ts"),
    bunvex: resolve(import.meta.dir, "../src/index.ts"),
  },
  values: {
    reference: resolve(reference, "dist/esm-types/values/index.d.ts"),
    bunvex: resolve(import.meta.dir, "../../values/src/index.ts"),
  },
} as const;

describe("bunvex's entries export the reference's names (STUDY-180)", () => {
  test("the reference is the client version bunvex matches", () => {
    // The one Convex's oracle release ships (STUDY-193 Q2); sync-e2e keeps testing the 1.46.0 floor.
    expect(version).toBe("1.48.0");
  });

  for (const [entry, files] of Object.entries(ENTRIES) as [keyof typeof ENTRIES, (typeof ENTRIES)["server"]][]) {
    test(`${entry}: every name, but the listed ones`, () => {
      const theirs = exportedNames(files.reference);
      const ours = exportedNames(files.bunvex);
      // Sanity: the walk saw the entries (the study counted 172 and 40 names).
      expect(theirs.size).toBeGreaterThan(entry === "server" ? 150 : 30);
      const missing = [...theirs].filter((n) => !ours.has(n) && !(n in NOT_EXPORTED[entry])).sort();
      expect(missing).toEqual([]);
      // The list stays exact: each name is the reference's, and still missing from bunvex.
      const stale = Object.keys(NOT_EXPORTED[entry]).filter((n) => !theirs.has(n) || ours.has(n));
      expect(stale).toEqual([]);
    }, 60_000);
  }
});

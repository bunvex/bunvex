// Codegen for components (STUDY-156 §4.3), with the content of Convex's templates
// (npm-packages/convex/src/cli/codegen_templates/component_api.ts, validator_helpers.ts):
//
// - the `components` of an `api`: one entry per child instance, its type the child's own
//   `ComponentApi<"<name>">` from its `_generated/component.js`, imported by a package's name when the child was
//   imported by one, else a relative path;
// - a local component's `component.ts`: `ComponentApi<Name>`, its exports written out as
//   `FunctionReference<type, "internal", Args, Returns, Name>`, the types made from its functions' validators
//   (`any` without one), so the file stands alone.
//
// Both read a definition's analysis as `start_push` answers it: the server's, or the same analysis made in the
// CLI without a deployment (`componentAnalysis`, DV-532).
import { realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { posix } from "./bundle.ts";
import { type CodegenConfig, componentPackagesOf, header, importsOf, runCodegen, type WriteMode } from "./codegen.ts";
import type { ComponentDirectory, Components } from "./components.ts";

type Validator = { type: string; [k: string]: unknown };
type AnalyzedFunction = { name: string; udfType: string; args: string | null; returns: string | null };
type Export = { type: "leaf"; leaf: string } | { type: "branch"; branch: [string, Export][] };
/** One definition's analysis (Convex's `EvaluatedComponentDefinition`), as much as codegen reads. */
export type DefinitionAnalysis = {
  definition: { childComponents: { name: string; path: string }[]; exports: Export & { type: "branch" } };
  functions: Record<string, { functions: AnalyzedFunction[] }>;
};
/** `start_push`'s `analysis`: by definition path, the app's `""`. */
export type Analysis = Record<string, DefinitionAnalysis>;

/** An object key as prettier writes it: bare when it is an identifier, else quoted. */
const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

/** A literal's type (Convex's `convexValueToLiteral`); an int64 literal comes as `{"$integer": base64}`. */
function literalType(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object" && typeof (value as { $integer?: unknown }).$integer === "string") {
    const bytes = Buffer.from((value as { $integer: string }).$integer, "base64");
    return `${bytes.readBigInt64LE(0)}n`;
  }
  throw new Error("Unsupported literal type");
}

/** A validator's TypeScript type (Convex's `validatorToType`); a component's ids are strings. */
export function validatorType(v: Validator): string {
  switch (v.type) {
    case "null":
    case "number":
    case "bigint":
    case "boolean":
    case "string":
    case "any":
      return v.type;
    case "commitTs":
      return 'bigint | import("@bunvex/values").CommitTsPlaceholder';
    case "bytes":
      return "ArrayBuffer";
    case "literal":
      return literalType(v.value);
    case "id":
      return "string";
    case "array":
      return `Array<${validatorType(v.value as Validator)}>`;
    case "record":
      return `Record<${validatorType(v.keys as Validator)}, ${validatorType((v.values as { fieldType: Validator }).fieldType)}>`;
    case "union":
      return (v.value as Validator[]).map(validatorType).join(" | ");
    case "object": {
      const fields = Object.entries(v.value as Record<string, { fieldType: Validator; optional: boolean }>);
      if (!fields.length) return "{}";
      return `{ ${fields.map(([k, f]) => `${key(k)}${f.optional ? "?" : ""}: ${validatorType(f.fieldType)}`).join("; ")} }`;
    }
    default:
      throw new Error(`Unsupported validator type: ${v.type}`);
  }
}

const parsed = (json: string | null): Validator | null => (json ? (JSON.parse(json) as Validator | null) : null);

/** A function's reference type (Convex's `codegenFunctionReference`), always `"internal"` across a component. */
function referenceType(analysis: DefinitionAnalysis, leaf: string, name: string | undefined): string {
  if (!leaf.startsWith("_reference/function/")) throw new Error(`Invalid function reference: ${leaf}`);
  const [modulePath, functionName] = leaf.slice("_reference/function/".length).split(":") as [string, string];
  const module = analysis.functions[modulePath.endsWith(".js") ? modulePath : `${modulePath}.js`];
  if (!module) throw new Error(`Module not found: ${modulePath}`);
  const f = module.functions.find((fn) => fn.name === functionName);
  if (!f) throw new Error(`Function not found: ${functionName}`);
  const args = parsed(f.args);
  if (args && args.type !== "object" && args.type !== "any")
    throw new Error(`Unexpected argument validator type: ${args.type}`);
  const returns = parsed(f.returns);
  const params = [
    JSON.stringify(f.udfType.toLowerCase()),
    '"internal"',
    args ? validatorType(args) : "any",
    returns ? validatorType(returns) : "any",
    ...(name ? [name] : []),
  ];
  return `FunctionReference<${params.join(", ")}>`;
}

/** An export tree's type, its keys in code-unit order, indented from `indent`. */
function exportType(analysis: DefinitionAnalysis, e: Export, name: string | undefined, indent: string): string {
  if (e.type === "leaf") return referenceType(analysis, e.leaf, name);
  const entries = [...e.branch].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!entries.length) return "{}";
  const inner = `${indent}  `;
  return `{\n${entries.map(([k, child]) => `${inner}${key(k)}: ${exportType(analysis, child, name, inner)};`).join("\n")}\n${indent}}`;
}

/** A local component's `_generated/component.ts` (Convex's `componentTS`). */
export function componentTs(analysis: DefinitionAnalysis, server: string, header: string): string {
  return `${header}
import type { FunctionReference } from ${server};

/**
 * A utility for referencing a bunvex component's exposed API.
 *
 * Useful when expecting a parameter like \`components.myComponent\`.
 * Usage:
 * \`\`\`ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * \`\`\`
 */
export type ComponentApi<Name extends string | undefined = string | undefined> = ${exportType(analysis, analysis.definition.exports, "Name", "")};
`;
}

/**
 * The entries of `components` in the `api` of the definition at `from` (its directory): one per child instance,
 * typed by the child's `ComponentApi` (Convex's `componentApiLines`). The import is the package's name when the
 * child was imported by one; otherwise the child's directory, relative to `_generated/`.
 */
export function componentEntries(
  analysis: DefinitionAnalysis,
  from: string,
  directories: Map<string, ComponentDirectory>,
): string[] {
  return analysis.definition.childComponents.map((child) => {
    const d = directories.get(child.path);
    if (!d) throw new Error(`Invalid child component directory: ${child.path}`);
    const spec =
      d.importSpecifier && !d.importSpecifier.startsWith(".") && d.importSpecifier !== child.path
        ? d.importSpecifier
        : posix(relative(join(realpathSync(from), "_generated"), d.dir));
    return `  ${key(child.name)}: import(${JSON.stringify(`${spec}/_generated/component.js`)}).ComponentApi<${JSON.stringify(child.name)}>;`;
  });
}

const byDefinitionPath = (found: Components) => new Map(found.directories.map((d) => [d.definitionPath, d]));

/** The entries of the app's `components`: none before the analysis, or without a definition. */
export function appComponentEntries(found: Components, analysis: Analysis | null): string[] {
  const app = analysis?.[""];
  return app ? componentEntries(app, found.root, byDefinitionPath(found)) : [];
}

/**
 * Codegen in each local component's directory (Convex's `doInitialComponentCodegen` / `doFinalComponentCodegen`
 * for the non-root components): always `.ts` files, as Convex's; `initial` writes what the component's modules
 * need to bundle, the final pass (with the analysis) its `api` with its children's `components` and its
 * `component.ts`. A published component (a `.js` definition) has its own `_generated/` and is left alone.
 */
export function componentCodegen(
  found: Components,
  config: CodegenConfig,
  analysis: Analysis | null,
  opts: { mode?: WriteMode /** Only this component's directory (`--component-dir`). */; only?: string } = {},
) {
  const dirs = byDefinitionPath(found);
  for (const d of found.directories) {
    if (!d.local || (opts.only !== undefined && d.dir !== opts.only)) continue;
    const ts: CodegenConfig = {
      ...config,
      fileType: "ts",
      commonjs: false,
      packages: componentPackagesOf(d.dir, config.packages),
    };
    const mine = analysis?.[d.definitionPath];
    if (!mine) {
      runCodegen(d.dir, ts, { initial: true, mode: opts.mode });
      continue;
    }
    runCodegen(d.dir, ts, {
      mode: opts.mode,
      components: componentEntries(mine, d.dir, dirs),
      extra: {
        "component.ts": componentTs(mine, importsOf(ts.packages).server, header("Generated `ComponentApi` utility.")),
      },
    });
  }
}

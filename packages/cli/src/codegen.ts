// Code generation (STUDY-36): the functions directory's `_generated/` — `api`, `server` and `dataModel` —
// with the content of Convex's (npm-packages/convex/src/cli/codegen_templates, lib/codegen.ts), importing
// from `bunvex/server` and `bunvex/values`:
//
// - `api.d.ts` builds `api` / `internal` from the modules' types (`ApiFromModules`, `FilterApi`), one
//   `import type * as …` per module (the bundler's entry points); `api.js` is `anyApi`;
// - `server` re-exports the `*Generic` builders typed with the app's `DataModel`, and the context types;
// - `dataModel.d.ts` derives `DataModel`, `Doc`, `Id`, `TableNames` from `schema.ts` (`AnyDataModel`
//   without one);
// - `codegen.fileType: "ts"` in bunvex.json writes `.ts` files instead of `.js` + `.d.ts` pairs.
//
// The initial pass (before bundling) writes what is missing, and always `api.js`, so that modules importing
// `_generated/` bundle; the final pass writes everything. A file is only rewritten when its content changes,
// and entries of `_generated/` neither pass wrote are removed. The layout is the generator's own, matching
// what prettier makes of Convex's templates (G3); `components` is `{}` (G2); `env` is untyped (G4).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { entryPoints } from "./bundle.ts";

export type CodegenConfig = {
  fileType: "ts" | "js/dts";
  /** Where the generated files import from: `bunvex/*`, or `@bunvex/*` for an app on the scoped packages (STUDY-40). */
  packages?: "bunvex" | "@bunvex";
};

const posix = (p: string) => p.split(sep).join("/");
// The packages the generated files import (spelled at run time: they are text here, not imports).
const SERVER = ["bunvex", "server"].join("/");
const VALUES = ["bunvex", "values"].join("/");
type Imports = { server: string; values: string };
/** The quoted specifiers the generated files import. */
const importsOf = (packages: CodegenConfig["packages"]): Imports =>
  packages === "@bunvex"
    ? { server: JSON.stringify(`@${SERVER}`), values: JSON.stringify(`@${VALUES}`) }
    : { server: JSON.stringify(SERVER), values: JSON.stringify(VALUES) };

function header(description: string) {
  return `/* eslint-disable */
/**
 * ${description}
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run \`bunvex dev\`.
 * @module
 */
`;
}

/** A module's path without its extension (the key in `api`, the import path). */
export function importPath(modulePath: string): string {
  const p = modulePath.replace(/\\/g, "/");
  const dot = p.lastIndexOf(".");
  return dot === -1 ? p : p.slice(0, dot);
}

const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while " +
    "with let static yield await enum implements interface package private protected public"
  ).split(" "),
);

/** The identifier a module is imported as: `/` and `-` as `_`, and `_` after a name already taken. */
export function moduleIdentifier(modulePath: string): string {
  const id = importPath(modulePath).replace(/[/-]/g, "_");
  if (["fullApi", "api", "internal", "components"].includes(id) || RESERVED.has(id)) return `${id}_`;
  return id;
}

/** An object key as prettier writes it: bare when it is an identifier, else quoted. */
const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

/** The module paths, relative and with `/`, in code-unit order (Convex's `compareModulePaths`). */
export function modulePaths(functionsDir: string): string[] {
  return entryPoints(functionsDir)
    .map((p) => posix(relative(functionsDir, p)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const apiComment = (name: string, kind: "public" | "internal" | null) => `/**
 * A utility for referencing bunvex functions in your app's${kind ? ` ${kind}` : ""} API.
 *
 * Usage:
 * \`\`\`js
 * const myFunctionReference = ${name}.myModule.myFunction;
 * \`\`\`
 */`;

function fullApiLines(paths: string[]) {
  return paths.map((p) => `  ${key(importPath(p))}: typeof ${moduleIdentifier(p)};`).join("\n");
}

function moduleImports(paths: string[]) {
  return paths.map((p) => `import type * as ${moduleIdentifier(p)} from "../${importPath(p)}.js";`).join("\n");
}

const SERVER_TYPES = [
  "ActionBuilder",
  "HttpActionBuilder",
  "MutationBuilder",
  "QueryBuilder",
  "GenericActionCtx",
  "GenericMutationCtx",
  "GenericQueryCtx",
  "GenericDatabaseReader",
  "GenericDatabaseWriter",
];
const GENERIC_BUILDERS = [
  "actionGeneric",
  "httpActionGeneric",
  "queryGeneric",
  "mutationGeneric",
  "internalActionGeneric",
  "internalMutationGeneric",
  "internalQueryGeneric",
];
const BUILDERS: [name: string, type: string, generic: string][] = [
  ["query", 'QueryBuilder<DataModel, "public">', "queryGeneric"],
  ["internalQuery", 'QueryBuilder<DataModel, "internal">', "internalQueryGeneric"],
  ["mutation", 'MutationBuilder<DataModel, "public">', "mutationGeneric"],
  ["internalMutation", 'MutationBuilder<DataModel, "internal">', "internalMutationGeneric"],
  ["action", 'ActionBuilder<DataModel, "public">', "actionGeneric"],
  ["internalAction", 'ActionBuilder<DataModel, "internal">', "internalActionGeneric"],
  ["httpAction", "HttpActionBuilder", "httpActionGeneric"],
];
const BUILDER_DOCS: Record<string, string> = {
  query: "Define a query in this bunvex app's public API, readable by clients.",
  internalQuery: "Define a query that only other bunvex functions can call.",
  mutation: "Define a mutation in this bunvex app's public API, callable by clients.",
  internalMutation: "Define a mutation that only other bunvex functions can call.",
  action: "Define an action in this bunvex app's public API: it may call third-party services.",
  internalAction: "Define an action that only other bunvex functions can call.",
  httpAction: "Define an HTTP action, served by the router exported from `http.ts`.",
};
const CTX_TYPES = `/** The context of every query: a database reader, \`auth\` and \`storage\`. */
export type QueryCtx = GenericQueryCtx<DataModel>;

/** The context of every mutation: a database writer, \`auth\`, \`storage\` and \`scheduler\`. */
export type MutationCtx = GenericMutationCtx<DataModel>;

/** The context of every action: \`runQuery\`, \`runMutation\`, \`runAction\`, \`auth\`, \`storage\` and \`scheduler\`. */
export type ActionCtx = GenericActionCtx<DataModel>;

/** Reading the database (\`ctx.db\` in queries). */
export type DatabaseReader = GenericDatabaseReader<DataModel>;

/** Reading and writing the database (\`ctx.db\` in mutations). */
export type DatabaseWriter = GenericDatabaseWriter<DataModel>;
`;
const doc = (s: string) => `/**\n * ${s}\n */`;
const importList = (names: string[]) => `{\n${names.map((n) => `  ${n},`).join("\n")}\n}`;
const SERVER_DESCRIPTION = "Generated utilities for implementing server-side bunvex query and mutation functions.";
/** `v` typed with the app's tables (STUDY-100 T2, a bunvex addition): the value is bunvex's `v`. */
const V_DOC = doc(
  "Validators, as `v` from bunvex/values, with `v.id` typed by this app's tables and the system tables: editors\n * complete them, and a misspelled table is a type error (any name, with no schema or `strictTableNameTypes: false`).",
);
const V_TYPE = "TableValidators<TableNamesInDataModel<DataModel> | SystemTableNames>";

/** The generated files, by name (Convex's dynamic modes: what the code says, no deployment needed). */
export function generatedFiles(
  paths: string[],
  opts: { hasSchema: boolean; fileType: CodegenConfig["fileType"]; packages?: CodegenConfig["packages"] },
): {
  dataModel: Record<string, string>;
  server: Record<string, string>;
  api: Record<string, string>;
  apiStub: Record<string, string>;
} {
  const q = importsOf(opts.packages);
  const ts = opts.fileType === "ts";
  const dataModel = opts.hasSchema ? dataModelWithSchema(q) : dataModelWithoutSchema(q);
  const serverDts = `${header(SERVER_DESCRIPTION)}
import type ${importList([...SERVER_TYPES, "SystemTableNames", "TableNamesInDataModel"])} from ${q.server};
import type { TableValidators } from ${q.values};
import type { DataModel } from "./dataModel.js";

${BUILDERS.map(([n, t]) => `${doc(BUILDER_DOCS[n]!)}\nexport declare const ${n}: ${t};`).join("\n\n")}

${doc("The deployment's environment variables.")}
export declare const env: Record<string, string | undefined>;

${V_DOC}
export declare const v: ${V_TYPE};

${CTX_TYPES}`;
  const serverJs = `${header(SERVER_DESCRIPTION)}
import ${importList(GENERIC_BUILDERS)} from ${q.server};

${BUILDERS.map(([n, , g]) => `${doc(BUILDER_DOCS[n]!)}\nexport const ${n} = ${g};`).join("\n\n")}

${doc("The deployment's environment variables.")}
export const env = process.env;

${V_DOC}
export { v } from ${q.values};
`;
  const serverTs = `${header(SERVER_DESCRIPTION)}
import ${importList(GENERIC_BUILDERS)} from ${q.server};
import type ${importList([...SERVER_TYPES, "SystemTableNames", "TableNamesInDataModel"])} from ${q.server};
import { type TableValidators, v as untypedV } from ${q.values};
import type { DataModel } from "./dataModel.js";

${BUILDERS.map(([n, t, g]) => `${doc(BUILDER_DOCS[n]!)}\nexport const ${n}: ${t} = ${g};`).join("\n\n")}

${doc("The deployment's environment variables.")}
export const env: Record<string, string | undefined> = (
  globalThis as unknown as { process: { env: Record<string, string | undefined> } }
).process.env;

${V_DOC}
export const v: ${V_TYPE} = untypedV;

${CTX_TYPES}`;
  const imports = paths.length ? `${moduleImports(paths)}\n\n` : "";
  const fullApiType = paths.length ? `ApiFromModules<{\n${fullApiLines(paths)}\n}>` : "ApiFromModules<{}>";
  const apiHeader = header("Generated `api` utility.");
  const apiDts = `${apiHeader}
${imports}import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from ${q.server};

declare const fullApi: ${fullApiType};

${apiComment("api", "public")}
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

${apiComment("internal", "internal")}
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
`;
  const apiJs = `${apiHeader}
import { anyApi } from ${q.server};

${apiComment("api", null)}
export const api = anyApi;
export const internal = anyApi;
export const components = {};
`;
  const apiTs = `${apiHeader}
${imports}import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from ${q.server};
import { anyApi } from ${q.server};

const fullApi: ${fullApiType} = anyApi as any;

${apiComment("api", "public")}
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

${apiComment("internal", "internal")}
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = {};
`;
  // Before the modules can be read: any api, so that the modules (which import it) bundle.
  const apiStubDts = `${apiHeader}
import type { AnyApi } from ${q.server};

export declare const api: AnyApi;
export declare const internal: AnyApi;
export declare const components: {};
`;
  const apiStubTs = `${apiHeader}
import type { AnyApi } from ${q.server};
import { anyApi } from ${q.server};

export const api: AnyApi = anyApi;
export const internal: AnyApi = anyApi;
export const components = {};
`;
  return ts
    ? {
        dataModel: { "dataModel.ts": dataModel },
        server: { "server.ts": serverTs },
        api: { "api.ts": apiTs },
        apiStub: { "api.ts": apiStubTs },
      }
    : {
        dataModel: { "dataModel.d.ts": dataModel },
        server: { "server.js": serverJs, "server.d.ts": serverDts },
        api: { "api.js": apiJs, "api.d.ts": apiDts },
        apiStub: { "api.js": apiJs, "api.d.ts": apiStubDts },
      };
}

const ID_DOC = `/**
 * An identifier for a document in bunvex: its \`_id\`.
 *
 * Ids are strings at run time; the type tells one table's ids from another's, and from other strings.
 * Load a document with \`db.get(tableName, id)\` in queries and mutations.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */`;
const DATA_MODEL_DOC = `/**
 * The app's data model: its tables, the type of their documents, and their indexes.
 *
 * It parameterizes \`queryGeneric\`, \`mutationGeneric\` and the database types.
 */`;

function dataModelWithSchema(q: Imports) {
  return `${header("Generated data model types.")}
import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  SystemTableNames,
  TableNamesInDataModel,
} from ${q.server};
import type { GenericId } from ${q.values};
import schema from "../schema.js";

/**
 * The names of all of your tables.
 */
export type TableNames = TableNamesInDataModel<DataModel>;

/**
 * The type of a document stored in bunvex.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;

${ID_DOC}
export type Id<TableName extends TableNames | SystemTableNames> = GenericId<TableName>;

${DATA_MODEL_DOC}
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
`;
}

function dataModelWithoutSchema(q: Imports) {
  return `${header("Generated data model types.")}
import type { AnyDataModel } from ${q.server};
import type { GenericId } from ${q.values};

/**
 * No \`schema.ts\` file found!
 *
 * Without a schema the types are permissive (\`Doc = any\`). Add a \`schema.ts\` for type-safe documents,
 * then rerun codegen with \`bunvex dev\`.
 */

/**
 * The names of all of your tables.
 */
export type TableNames = string;

/**
 * The type of a document stored in bunvex.
 */
export type Doc = any;

${ID_DOC}
export type Id<TableName extends TableNames = TableNames> = GenericId<TableName>;

${DATA_MODEL_DOC}
export type DataModel = AnyDataModel;
`;
}

export type CodegenResult = { written: string[]; removed: string[] };

/** Write `content` to `path` unless it already holds it. */
function writeIfChanged(path: string, content: string, written: string[], name: string) {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  writeFileSync(path, content);
  written.push(name);
}

/**
 * Run codegen in `functionsDir`. `initial`: the pass before bundling (Convex's initial component codegen),
 * which keeps files a final pass wrote and writes stubs for the others; otherwise the final pass.
 */
export function runCodegen(functionsDir: string, config: CodegenConfig, opts: { initial?: boolean } = {}) {
  const dir = join(functionsDir, "_generated");
  mkdirSync(dir, { recursive: true });
  const hasSchema = existsSync(join(functionsDir, "schema.ts")) || existsSync(join(functionsDir, "schema.js"));
  const files = generatedFiles(opts.initial ? [] : modulePaths(functionsDir), {
    hasSchema,
    fileType: config.fileType,
    packages: config.packages,
  });
  const result: CodegenResult = { written: [], removed: [] };
  const keep = new Set<string>();
  // In dependency order: dataModel (imports the schema), server (imports dataModel), api (imports the
  // modules, which import server), so a watcher never sees an import of a file not yet written.
  const groups = opts.initial
    ? [
        { files: files.dataModel, onlyIfMissing: true },
        { files: files.server, onlyIfMissing: true },
        // `api.js` always; the typed declarations only when there are none yet.
        ...Object.entries(files.apiStub).map(([name, content]) => ({
          files: { [name]: content },
          onlyIfMissing: name !== "api.js",
        })),
      ]
    : [
        { files: files.dataModel, onlyIfMissing: false },
        { files: files.server, onlyIfMissing: false },
        { files: files.api, onlyIfMissing: false },
      ];
  for (const g of groups) {
    const names = Object.keys(g.files);
    for (const name of names) keep.add(name);
    // A pair stands or falls with its first file (`server.js` keeps its `server.d.ts`), as Convex's.
    if (g.onlyIfMissing && existsSync(join(dir, names[0]!))) continue;
    for (const [name, content] of Object.entries(g.files))
      writeIfChanged(join(dir, name), content, result.written, name);
  }
  for (const entry of readdirSync(dir)) {
    if (keep.has(entry)) continue;
    rmSync(join(dir, entry), { recursive: true, force: true });
    result.removed.push(entry);
  }
  return result;
}

const TSCONFIG = `{
  /* How bunvex typechecks the functions in this directory (\`bunvex deploy\`, \`bunvex codegen\`).
   * You can change it, but bunvex needs the settings in the second group.
   */
  "compilerOptions": {
    /* Settings bunvex does not need: change them freely. */
    "allowJs": true,
    "strict": true,
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "skipLibCheck": true,
    "allowSyntheticDefaultImports": true,

    /* Settings bunvex needs. */
    "target": "ESNext",
    "lib": ["ES2023", "dom"],
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "isolatedModules": true,
    "noEmit": true,
    /* bunvex's packages are TypeScript sources, which import each other by \`.ts\` paths. */
    "allowImportingTsExtensions": true
  },
  "include": ["./**/*"],
  "exclude": ["./_generated"]
}
`;

const README = `# Your bunvex functions

Write your queries, mutations and actions in this directory. Each file is a module; each exported function
is reachable as \`api.<file>.<export>\` once \`bunvex dev\` or \`bunvex deploy\` has generated \`_generated/\`.

A query with two arguments:

\`\`\`ts
// bunvex/myFunctions.ts
import { v } from ${JSON.stringify(VALUES)};
import { query } from "./_generated/server";

export const myQuery = query({
  args: { first: v.number(), second: v.string() },
  handler: async (ctx, args) => {
    const documents = await ctx.db.query("tablename").collect();
    return documents.slice(0, args.first);
  },
});
\`\`\`

Called from React:

\`\`\`ts
const data = useQuery(api.myFunctions.myQuery, { first: 10, second: "hello" });
\`\`\`

A mutation:

\`\`\`ts
export const myMutation = mutation({
  args: { first: v.string(), second: v.string() },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("messages", { body: args.first, author: args.second });
    return await ctx.db.get(id);
  },
});
\`\`\`

Called from React:

\`\`\`ts
const mutate = useMutation(api.myFunctions.myMutation);
mutate({ first: "Hello!", second: "me" });
\`\`\`
`;

/**
 * Convex's `codegen --init`: `tsconfig.json` unless there is one, and `README.md` unless the functions
 * directory existed before. Returns the files written.
 */
export function initFunctionsDir(functionsDir: string): string[] {
  const existed = existsSync(functionsDir);
  mkdirSync(functionsDir, { recursive: true });
  const written: string[] = [];
  if (!existed) {
    writeFileSync(join(functionsDir, "README.md"), README);
    written.push("README.md");
  }
  if (!existsSync(join(functionsDir, "tsconfig.json"))) {
    writeFileSync(join(functionsDir, "tsconfig.json"), TSCONFIG);
    written.push("tsconfig.json");
  }
  return written;
}

export type TypecheckMode = "enable" | "try" | "disable";
export type TypecheckResult = { ok: true; skipped?: string; warning?: string } | { ok: false; output: string };
/** Convex's `TypescriptCompiler`: `tsc`, or `tsgo` from `@typescript/native-preview` (STUDY-117). */
export type TypescriptCompiler = "tsc" | "tsgo";

/** Where the app's compiler is, looked for in the project as Convex's `findTypeScriptCompilerPath` does. */
export function compilerPath(cwd: string, compiler: TypescriptCompiler): string | undefined {
  const modules = join(cwd, "node_modules");
  const candidates =
    compiler === "tsgo"
      ? // `bin/tsgo` in newer previews, `bin/tsgo.js` before.
        ["tsgo", "tsgo.js"].map((f) => join(modules, "@typescript", "native-preview", "bin", f))
      : // TypeScript 7's alias when the TypeScript 6 API is also installed, then TypeScript.
        [join(modules, "@typescript", "native", "bin", "tsc"), join(modules, "typescript", "bin", "tsc")];
  return candidates.find((p) => existsSync(p));
}

/** One typecheck's outcome, as Convex's `TypecheckResult`, with what each prints. */
export type TypecheckRun =
  | { kind: "cantTypecheck"; why: string }
  | { kind: "success"; warning?: string }
  | { kind: "failed"; output: string };

// In the standalone executable (STUDY-39) `process.execPath` is bunvex itself: BUN_BE_BUN makes it Bun.
async function spawnCompiler(path: string, args: string[], cwd: string) {
  const p = Bun.spawn([process.execPath, path, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BUN_BE_BUN: "1" },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

/** Below Convex's recommended TypeScript (4.8.4). */
function olderThanRecommended(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  return major !== 4 ? major < 4 : minor !== 8 ? minor < 8 : patch < 4;
}

const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Convex's `typeCheckFunctions`: the compiler on the functions' project, or why it cannot run (no
 * `tsconfig.json`, no compiler). It runs `<compiler> --noEmit --project <functionsDir> --pretty true` (owner,
 * 2026-10-05: DV-387); "No inputs were found" (TS18003) passes, as Convex's. An older TypeScript gets
 * Convex's warning, printed after a typecheck that passed.
 */
export async function runTypecheck(
  functionsDir: string,
  cwd: string,
  compiler: TypescriptCompiler = "tsc",
): Promise<TypecheckRun> {
  if (!existsSync(join(functionsDir, "tsconfig.json")))
    return {
      kind: "cantTypecheck",
      why: `Found no ${posix(relative(cwd, join(functionsDir, "tsconfig.json")))} to typecheck the functions with, so skipping typecheck. Run \`bunvex codegen --init\` to create one.`,
    };
  const path = compilerPath(cwd, compiler);
  if (!path) return { kind: "cantTypecheck", why: `No \`${compiler}\` binary found, so skipping typecheck.` };
  const [version, run] = await Promise.all([
    spawnCompiler(path, ["--version"], cwd),
    // The project relative to the project directory, as Convex passes it, so the errors name files from there.
    spawnCompiler(path, ["--noEmit", "--project", relative(cwd, functionsDir) || ".", "--pretty", "true"], cwd),
  ]);
  const output = `${run.out}${run.err}`.trim();
  const v = /Version (.*)/.exec(version.out)?.[1];
  const warning =
    v && olderThanRecommended(v)
      ? "bunvex works best with TypeScript version 4.8.4 or newer -- npm i --save-dev typescript@latest to update."
      : undefined;
  if (run.code === 0 || output.replace(ANSI_COLOR, "").startsWith("error TS18003")) return { kind: "success", warning };
  return { kind: "failed", output };
}

/**
 * Convex's typecheck step (`typeCheckFunctionsInMode`): `try` skips it when it cannot run (no `tsconfig.json`,
 * no compiler) and `enable` fails then; both fail on type errors. `compiler` is bunvex.json's
 * `typescriptCompiler` (default `tsc`).
 */
export async function typecheck(
  functionsDir: string,
  cwd: string,
  mode: TypecheckMode,
  compiler: TypescriptCompiler = "tsc",
): Promise<TypecheckResult> {
  if (mode === "disable") return { ok: true, skipped: "disabled" };
  const run = await runTypecheck(functionsDir, cwd, compiler);
  if (run.kind === "cantTypecheck")
    return mode === "enable" ? { ok: false, output: run.why } : { ok: true, skipped: run.why };
  return run.kind === "success" ? { ok: true, warning: run.warning } : { ok: false, output: run.output };
}

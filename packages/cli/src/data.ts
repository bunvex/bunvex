// `bunvex data` (STUDY-43), as Convex's `npx convex data` (npm-packages/convex/src/cli/data.ts, lib/data.ts):
// without a table, the user tables; with one, its newest (or oldest) documents as a table, a JSON array or
// one per line, each value printed as Convex's CLI prints it.
import { fromJsonValue, type JSONValue, type Value } from "@bunvex/values";
import {
  argumentError,
  invalidArgument,
  invalidChoice,
  missingArgument,
  optionsIn,
  tooManyArguments,
  unknownOption,
} from "./args.ts";
import type { Io } from "./io.ts";
import { acquireTarget } from "./local-deployment.ts";
import { adminRequest, NO_DEPLOYMENT, TARGET_OPTIONS, type Target, takeTargetFlags } from "./target.ts";

export const DATA_USAGE = `Usage: bunvex data [table] [options]

List the deployment's tables, or print a table's documents.

  List tables:                  bunvex data
  List documents in a table:    bunvex data tableName

This works with system tables, such as \`_storage\`, in addition to your own tables.

Options:
  --limit <n>          list only the \`n\` most recently created documents (default: 100)
  --order <choice>     order the documents by their \`_creationTime\`: asc or desc (default: desc)
  --format <format>    jsonArray (aka json): a JSON array of objects; jsonLines (aka jsonl): an object per
                       line; pretty: a table for people (the default)
${TARGET_OPTIONS}`;

const FORMATS = ["jsonArray", "json", "jsonLines", "jsonl", "pretty"] as const;
type Format = (typeof FORMATS)[number];

/** A value as Convex's CLI prints it (`lib/data.ts` `stringify`). */
export function stringify(value: Value): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "number" || typeof value === "boolean") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof ArrayBuffer) return `Bytes("${Buffer.from(value).toString("base64")}")`;
  if (Array.isArray(value)) return `[${value.map(stringify).join(", ")}]`;
  const pairs = Object.entries(value)
    .map(([k, v]) => `"${k}": ${stringify(v)}`)
    .join(", ");
  return `{ ${pairs} }`;
}

/** Convex's `runSystemPaginatedQuery`: page after page until done or `limit` results. */
async function paginated(target: Target, path: string, args: Record<string, unknown>, limit?: number) {
  const results: unknown[] = [];
  let cursor: string | null = null;
  let isDone = false;
  while (!isDone && (limit === undefined || results.length < limit)) {
    const r = (await adminRequest(target, "/api/query", {
      path,
      args: { ...args, paginationOpts: { cursor, numItems: limit === undefined ? 10000 : limit - results.length } },
    })) as {
      status: string;
      value?: { page: unknown[]; isDone: boolean; continueCursor: string };
      errorMessage?: string;
    };
    if (r.status !== "success") throw new Error(r.errorMessage ?? `${path} failed`);
    isDone = r.value!.isDone;
    cursor = r.value!.continueCursor;
    results.push(...r.value!.page);
  }
  return results;
}

/** Convex's `logDocumentsTable`; the lines, and whether any was cut to the terminal's width. */
export function documentsTable(
  rows: Record<string, string>[],
  columns?: number,
): { lines: string[]; truncated: boolean } {
  const widths: Record<string, number> = {};
  for (const row of rows) for (const c in row) widths[c] = Math.max(row[c]!.length, widths[c] ?? 0);
  const sorted = Object.keys(widths).sort();
  const fields = [...new Set(["_id", "_creationTime", ...sorted])];
  const columnWidths = fields.map((f) => widths[f]!);
  let truncated = false;
  const limit = (line: string) => {
    if (columns === undefined) return line;
    const max = columns - 10;
    if (line.length > max) truncated = true;
    return line.slice(0, max);
  };
  const lines = [
    limit(fields.map((f, i) => f.padEnd(columnWidths[i]!)).join(" | ")),
    limit(columnWidths.map((w) => "-".repeat(w)).join("-|-")),
    ...rows.map((row) => limit(fields.map((f, i) => (row[f] ?? "").padEnd(columnWidths[i]!)).join(" | "))),
  ];
  return { lines, truncated };
}

export async function dataCommand(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(DATA_USAGE);
    return 0;
  }
  const taken = takeTargetFlags(args);
  // Convex's `data` shows its help after an argument error.
  if (typeof taken === "string") return argumentError(io, taken, DATA_USAGE);
  const positional: string[] = [];
  let table: string | undefined;
  let limit = 100;
  let order: "asc" | "desc" = "desc";
  let format: Format | undefined;
  const r = taken.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const value = (flag: string) => (a.includes("=") ? a.slice(flag.length + 1) : r[++i]);
    if (a === "--limit" || a.startsWith("--limit=")) {
      const v = value("--limit");
      if (v === undefined) return argumentError(io, missingArgument("--limit <n>"), DATA_USAGE);
      // Convex's `parsePositiveInteger`: a number (`+v`), above 0.
      const n = +v;
      if (Number.isNaN(n)) return argumentError(io, invalidArgument("--limit <n>", v, "Not a number."), DATA_USAGE);
      if (n <= 0) return argumentError(io, invalidArgument("--limit <n>", v, "Not a positive number."), DATA_USAGE);
      limit = n;
    } else if (a === "--order" || a.startsWith("--order=")) {
      const v = value("--order");
      if (v === undefined) return argumentError(io, missingArgument("--order <choice>"), DATA_USAGE);
      if (v !== "asc" && v !== "desc")
        return argumentError(io, invalidChoice("--order <choice>", v, ["asc", "desc"]), DATA_USAGE);
      order = v;
    } else if (a === "--format" || a.startsWith("--format=")) {
      const v = value("--format");
      if (v === undefined) return argumentError(io, missingArgument("--format <format>"), DATA_USAGE);
      if (!FORMATS.includes(v as Format))
        return argumentError(io, invalidChoice("--format <format>", v, FORMATS), DATA_USAGE);
      format = v as Format;
    } else if (a === "--component" || a.startsWith("--component=")) {
      // DV-224 (STUDY-43 D1): no components yet.
      return argumentError(io, "--component: bunvex does not have components yet.");
    } else if (!a.startsWith("-")) positional.push(a);
    else return argumentError(io, unknownOption(a, optionsIn(DATA_USAGE)), DATA_USAGE);
  }
  if (positional.length > 1) return argumentError(io, tooManyArguments("data", 1, positional.length), DATA_USAGE);
  table = positional[0];

  let acquired: Awaited<ReturnType<typeof acquireTarget>>;
  try {
    acquired = await acquireTarget(taken.flags, io);
  } catch (e) {
    io.err(`bunvex data: ${(e as Error).message}`);
    return 1;
  }
  if (!acquired) {
    io.err(`bunvex data: ${NO_DEPLOYMENT}`);
    return 1;
  }
  const target = acquired.target;
  try {
    if (table === undefined) {
      const tables = (await paginated(target, "_system/cli/tables", {})) as { name: string }[];
      if (tables.length === 0) {
        // Convex names the deployment only for a cloud one; a self-hosted deployment has no name here.
        io.err("There are no tables in the database.");
        return 0;
      }
      io.out(
        tables
          .map((t) => t.name)
          .sort()
          .join("\n"),
      );
      return 0;
    }
    const data = (await paginated(target, "_system/cli/tableData", { table, order }, limit + 1)).map(
      (d) => fromJsonValue(d as JSONValue) as Record<string, Value>,
    );
    if (data.length === 0) {
      io.err("There are no documents in this table.");
      return 0;
    }
    const shown = data.slice(0, limit);
    if (format === "json" || format === "jsonArray") io.out(`[\n${shown.map(stringify).join(",\n")}\n]`);
    else if (format === "jsonLines" || format === "jsonl") io.out(shown.map(stringify).join("\n"));
    else {
      const rows = shown.map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, stringify(v)])));
      const { lines, truncated } = documentsTable(rows, io.isTTY ? io.columns : undefined);
      for (const l of lines) io.out(l);
      if (truncated)
        io.err(
          "Lines were truncated to fit the terminal width. Pipe the command to see the full output, such as:\n  `bunvex data tableName | less -S`",
        );
      if (data.length > limit)
        io.err(
          `Showing the ${limit} ${order === "desc" ? "most recently" : "oldest"} created document${
            limit > 1 ? "s" : ""
          }. Use the --limit option to see more.`,
        );
    }
    return 0;
  } catch (e) {
    io.err(`bunvex data: ${(e as Error).message}`);
    return 1;
  } finally {
    await acquired.release();
  }
}

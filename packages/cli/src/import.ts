// `bunvex import` (STUDY-42 PR 3), as Convex's `npx convex import` (npm-packages/convex/src/cli/convexImport.ts,
// lib/convexImport.ts): upload the file in parts, wait while the deployment parses it, show its change
// summary and ask before anything is deleted, start it, then follow its progress to the end.
import { existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Io } from "./io.ts";
import { acquireTarget } from "./local-deployment.ts";
import { adminRequest, NO_DEPLOYMENT, TARGET_OPTIONS, type Target, takeTargetFlags } from "./target.ts";

export const IMPORT_USAGE = `Usage: bunvex import <path> [options]

Import data from a file into the deployment.

  From a snapshot:      bunvex import snapshot.zip
  For a single table:   bunvex import --table tableName file.json

Options:
  --table <table>      destination table; required for csv, jsonLines and jsonArray, not allowed for zip
  --replace            replace all existing data in any of the imported tables
  --append             append the imported data to any existing tables
  --replace-all        replace all existing data in the deployment with the imported tables, deleting
                       tables that are not in the import file or the schema, and clearing tables that are
                       in the schema but not in the import file
  -y, --yes            do not ask before an import deletes existing documents
  --format <format>    csv, jsonLines, jsonArray or zip; only needed when the file has no extension
                       - CSV files need a header; each cell becomes a (floating point) number or a string
                       - JSON files are an array of objects; JSON Lines files have an object per line
                       - ZIP files have <table>/documents.jsonl per table, as \`bunvex export\` writes them
${TARGET_OPTIONS}`;

/** Convex's chunk size: the deployment takes 5 MiB parts (but the last); BUNVEX_IMPORT_CHUNK_SIZE overrides it. */
const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
const FORMATS = ["csv", "jsonLines", "jsonArray", "zip"] as const;
type Format = (typeof FORMATS)[number];
const EXTENSIONS: Record<Format, string> = { csv: ".csv", jsonLines: ".jsonl", jsonArray: ".json", zip: ".zip" };

const BYTE_UNITS = ["bytes", "KiB", "MiB", "GiB", "TiB", "PiB"];
/** Convex's `formatSize`: one decimal, dropped when ".0". */
export function formatSize(n: number): string {
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  if (Number(value.toFixed(1)) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1).replace(/\.0$/, "")} ${BYTE_UNITS[unit]}`;
}

type ImportState = {
  state: "uploaded" | "waiting_for_confirmation" | "in_progress" | "completed" | "failed";
  message_to_confirm?: string;
  require_manual_confirmation?: boolean;
  progress_message?: string;
  checkpoint_messages?: string[];
  num_rows_written?: { $integer: string } | number;
  error_message?: string;
};

async function systemQuery(target: Target, path: string, args: object): Promise<unknown> {
  const r = (await adminRequest(target, "/api/query", { path, args })) as {
    status: string;
    value?: unknown;
    errorMessage?: string;
  };
  if (r.status !== "success") throw new Error(r.errorMessage ?? `${path} failed`);
  return r.value;
}

const int64 = (v: ImportState["num_rows_written"]) =>
  v && typeof v === "object" ? Buffer.from(v.$integer, "base64").readBigInt64LE() : BigInt(v ?? 0);

/** Ask a yes/no question (default yes); null when there is no terminal to ask on. */
function askYesNo(io: Io, question: string): boolean | null {
  const answer = io.prompt?.(`${question} (Y/n)`);
  if (answer === undefined || answer === null) return null;
  return !/^n/i.test(answer.trim());
}

export async function importCommand(args: string[], io: Io, opts: { pollMs?: number } = {}): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(IMPORT_USAGE);
    return 0;
  }
  const taken = takeTargetFlags(args);
  if (typeof taken === "string") {
    io.err(`bunvex import: ${taken}`);
    return 2;
  }
  let path: string | undefined;
  let table: string | undefined;
  let format: Format | undefined;
  let mode: "requireEmpty" | "append" | "replace" | "replaceAll" = "requireEmpty";
  const modes: string[] = [];
  let yes = false;
  const r = taken.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const value = (flag: string) => (a.includes("=") ? a.slice(flag.length + 1) : r[++i]);
    const flagMode = ({ "--replace": "replace", "--append": "append", "--replace-all": "replaceAll" } as const)[
      a as "--replace"
    ];
    if (flagMode) {
      mode = flagMode;
      modes.push(flagMode);
    } else if (a === "-y" || a === "--yes") yes = true;
    else if (a === "--table" || a.startsWith("--table=")) table = value("--table");
    else if (a === "--format" || a.startsWith("--format=")) {
      const f = value("--format");
      if (!FORMATS.includes(f as Format)) {
        io.err(
          `bunvex import: option '--format <format>' argument '${f}' is invalid. Allowed choices are ${FORMATS.join(", ")}.`,
        );
        return 2;
      }
      format = f as Format;
    } else if (!a.startsWith("-") && path === undefined) path = a;
    else {
      io.err(`bunvex import: unknown option ${a}\n\n${IMPORT_USAGE}`);
      return 2;
    }
  }
  if (modes.length > 1) {
    const flag = (m: string) => `--${m === "replaceAll" ? "replace-all" : m}`;
    io.err(`bunvex import: option '${flag(modes[1]!)}' cannot be used with option '${flag(modes[0]!)}'`);
    return 2;
  }
  if (!path) {
    io.err(`bunvex import: missing required argument 'path'\n\n${IMPORT_USAGE}`);
    return 2;
  }
  const file = resolve(io.cwd, path);
  if (!existsSync(file)) {
    io.err(`Error: Path ${path} does not exist.`);
    return 1;
  }
  // The format: --format, else the extension (a mismatch only warns).
  const ext = extname(path);
  if (ext !== "") {
    if (format !== undefined && ext !== EXTENSIONS[format])
      io.err(
        `Warning: Extension of file ${path} (${ext}) does not match specified format: ${format} (${EXTENSIONS[format]}).`,
      );
    format ??= (Object.keys(EXTENSIONS) as Format[]).find((f) => EXTENSIONS[f] === ext);
  }
  if (format === undefined) {
    io.err(
      "No input file format inferred by the filename extension or specified. Specify your input file's format using the `--format` flag.",
    );
    return 1;
  }
  if (table === undefined && format !== "zip") {
    io.err(`Error: The \`--table\` option is required for format ${format}`);
    return 1;
  }
  if (table !== undefined && format === "zip") {
    io.err(`Error: The \`--table\` option is not allowed for format ${format}`);
    return 1;
  }

  let acquired: Awaited<ReturnType<typeof acquireTarget>>;
  try {
    acquired = await acquireTarget(taken.flags, io);
  } catch (e) {
    io.err(`bunvex import: ${(e as Error).message}`);
    return 1;
  }
  if (!acquired) {
    io.err(`bunvex import: ${NO_DEPLOYMENT}`);
    return 1;
  }
  const target = acquired.target;
  const tableNotice = table ? ` to table "${table}"` : "";
  const failed = `Importing data from "${path}"${tableNotice} failed`;
  try {
    const existing = (await systemQuery(target, "_system/cli/queryImport:list", {})) as { state: { state: string } }[];
    if (existing.some((i) => i.state.state === "in_progress")) {
      io.err("There is already a snapshot import in progress.");
      if (!yes) {
        const ok = askYesNo(io, "Start another import?");
        if (ok === null) {
          io.err("Cannot prompt for input in non-interactive terminals. (Start another import?)");
          return 1;
        }
        if (!ok) {
          io.err("Import canceled");
          return 1;
        }
      }
    }

    // Upload in parts (under 10 000 of them).
    const size = statSync(file).size;
    const envChunk = io.env.BUNVEX_IMPORT_CHUNK_SIZE ? Number.parseInt(io.env.BUNVEX_IMPORT_CHUNK_SIZE, 10) : undefined;
    const chunkSize = Math.max(envChunk ?? DEFAULT_CHUNK_SIZE, Math.ceil(size / 9999));
    io.err(`Importing ${path} (${formatSize(size)})`);
    let importId: string;
    try {
      const { uploadToken } = (await adminRequest(target, "/api/import/start_upload", {})) as { uploadToken: string };
      const partTokens: string[] = [];
      const blob = Bun.file(file);
      for (let start = 0, part = 1; start < size || part === 1; start += chunkSize, part++) {
        let chunk = new Uint8Array(await blob.slice(start, Math.min(start + chunkSize, size)).arrayBuffer());
        // A BOM at the start is dropped, as Convex's CLI does.
        if (part === 1 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) chunk = chunk.subarray(3);
        const res = await fetch(
          `${target.url}/api/import/upload_part?uploadToken=${encodeURIComponent(uploadToken)}&partNumber=${part}`,
          {
            method: "POST",
            headers: { "content-type": "application/octet-stream", authorization: `Bunvex ${target.adminKey}` },
            body: chunk,
          },
        );
        const body = (await res.json()) as string | { message?: string };
        if (!res.ok) throw new Error(typeof body === "string" ? body : (body.message ?? `${res.status}`));
        partTokens.push(body as string);
        io.err(`Uploading ${path} (${formatSize(Math.min(start + chunkSize, size))}/${formatSize(size)})`);
        if (start + chunkSize >= size) break;
      }
      const finished = (await adminRequest(target, "/api/import/finish_upload", {
        import: { tableName: table, mode, format },
        uploadToken,
        partTokens,
      })) as { importId: string };
      importId = finished.importId;
    } catch (e) {
      io.err(failed);
      io.err(`Error: ${(e as Error).message}`);
      return 1;
    }
    io.err("Parsing uploaded data");

    let checkpoints = 0;
    let shown = "";
    for (;;) {
      // Wait for a stable state, showing progress meanwhile.
      let state: ImportState;
      for (;;) {
        const row = (await systemQuery(target, "_system/cli/queryImport", { importId })) as {
          state: ImportState;
        } | null;
        state = row?.state ?? { state: "failed", error_message: `import ${importId} not found` };
        if (state.state === "in_progress") {
          const done = state.checkpoint_messages ?? [];
          while (done.length > checkpoints) io.err(done[checkpoints++]!);
          const msg = state.progress_message ?? "Importing";
          if (msg !== shown) {
            shown = msg;
            io.err(msg);
          }
        } else if (state.state !== "uploaded") break;
        await Bun.sleep(opts.pollMs ?? 500);
      }
      switch (state.state) {
        case "completed":
          io.err(`Added ${int64(state.num_rows_written)} documents${tableNotice}.`);
          return 0;
        case "failed":
          io.err(`${failed}\n\n${state.error_message}`);
          return 1;
        case "waiting_for_confirmation": {
          if (state.message_to_confirm) {
            io.err(state.message_to_confirm);
            if (state.require_manual_confirmation !== false && !yes) {
              const ok = askYesNo(io, "Perform import?");
              if (ok === null) {
                io.err("Cannot prompt for input in non-interactive terminals. (Perform import?)");
                return 1;
              }
              if (!ok) {
                io.err("Import canceled");
                return 1;
              }
            }
          }
          shown = "Importing";
          io.err(shown);
          try {
            await adminRequest(target, "/api/perform_import", { importId });
          } catch (e) {
            io.err(failed);
            io.err(`Error: ${(e as Error).message}`);
            return 1;
          }
          break;
        }
      }
    }
  } catch (e) {
    io.err(`bunvex import: ${(e as Error).message}`);
    return 1;
  } finally {
    await acquired.release();
  }
}

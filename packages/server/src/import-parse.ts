// Reading an import's file (STUDY-42 PR 3), as Convex's `snapshot_import/parse.rs`: one table for CSV, JSON
// Lines and a JSON array, every table of a snapshot ZIP; values as Convex reads them, and Convex's messages.
//
// - CSV: a header (trimmed of spaces), then each cell a float64 when it parses as Rust's `f64` (NaN and the
//   infinities become null, as serde_json writes them), else a string;
// - JSON Lines and JSON arrays: plain JSON, every number a float64, keys starting with `$` refused;
// - a ZIP: `<table>/documents.jsonl` per table, in the lossless encoding when its `generated_schema.jsonl`
//   says `"uniform"`; `_tables` (names and numbers), `_storage` (file metadata) and `_storage/<id>[.ext]`
//   files; other system tables skipped.
import { fromExportJson, isSimpleObject, type Value, validateObjectField } from "@bunvex/values";
import { InvalidZipError, type ZipReader } from "./zip-reader.ts";

/** A request or an import refused by its content (Convex's bad requests), with Convex's code. */
export class ImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

/** Convex's TRANSACTION_MAX_USER_WRITE_SIZE_BYTES: a JSON array file's limit. */
export const JSON_ARRAY_MAX_BYTES = 16 * 1024 * 1024;

export type ImportFormat = { format: "csv" | "jsonl" | "json_array"; table: string } | { format: "zip" };

/** One row as read: its JSON (numbers as JS reads them), and its text when it is a line of a file. */
export type RawRow = { json: unknown; text?: string };

export type ImportTable = {
  name: string;
  /** Rows in order; a new pass reads the file again. */
  rows: () => AsyncIterable<RawRow>;
  /** The lossless export encoding (a ZIP table whose generated schema is `"uniform"`). */
  uniform: boolean;
};

export type ParsedImport = {
  tables: ImportTable[];
  /** A ZIP's `_storage/<id>[.ext]` files, each read when it is imported. */
  storageFiles: { id: string; read: () => AsyncIterable<Uint8Array> }[];
};

const BOM = [0xef, 0xbb, 0xbf];

// ---------------------------------------------------------------- bytes to lines

/** UTF-8 text of a byte stream, chunk by chunk; invalid UTF-8 throws `onInvalid`. */
async function* utf8(bytes: AsyncIterable<Uint8Array>, onInvalid: () => Error): AsyncGenerator<string> {
  const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    for await (const b of bytes) yield dec.decode(b, { stream: true });
    const rest = dec.decode();
    if (rest) yield rest;
  } catch (e) {
    if (e instanceof TypeError) throw onInvalid();
    throw e;
  }
}

/** Lines without their `\n` (Rust's `read_line`: a last line without one counts, an empty end does not). */
async function* lines(text: AsyncIterable<string>): AsyncGenerator<string> {
  let buf = "";
  for await (const chunk of text) {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  if (buf) yield buf;
}

/** The first bytes start with a UTF-8 BOM: refused, as Convex. */
async function* refuseBom(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let first = true;
  for await (const b of bytes) {
    if (first && b.length >= 3 && BOM.every((x, i) => b[i] === x))
      throw new ImportError("Utf8BomNotSupported", "UTF-8 BOM is not supported. Please save your file without BOM.");
    first = false;
    yield b;
  }
}

const notUtf8 = () => new ImportError("NotUtf8", "Import wasn't valid UTF8: stream did not contain valid UTF-8");

async function* jsonLines(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<RawRow> {
  let n = 0;
  for await (const line of lines(utf8(bytes, notUtf8))) {
    n++;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (e) {
      throw new ImportError("JsonInvalidRow", `Row ${n} wasn't valid JSON: ${(e as Error).message}`);
    }
    yield { json, text: line };
  }
}

// ---------------------------------------------------------------- CSV

/** Rust's `str::parse::<f64>` grammar. */
const RUST_F64 = /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf|infinity|nan)$/i;

/** A CSV cell: a float64 when it parses as one, else the string (Convex's `parse_csv_cell`). */
export function parseCsvCell(s: string): unknown {
  if (!RUST_F64.test(s)) return s;
  const n = Number(
    s
      .replace(/^\+/, "")
      .replace(/^(-?)(inf|infinity)$/i, "$1Infinity")
      .replace(/^[+-]?nan$/i, "NaN"),
  );
  // serde_json writes NaN and the infinities as null.
  return Number.isFinite(n) ? n : null;
}

/** CSV records with the line each starts on (RFC 4180, as the `csv` crate reads it: blank lines skipped). */
async function* csvRecords(text: AsyncIterable<string>): AsyncGenerator<{ fields: string[]; line: number }> {
  let fields: string[] = [];
  let field = "";
  let quoted = false; // inside quotes
  let wasQuoted = false;
  let line = 1;
  let start = 1;
  let empty = true; // nothing read on this record yet
  let pendingQuote = false; // a quote inside quotes: an escaped one or the closing one
  let pendingCr = false;
  const end = () => {
    fields.push(field);
    const out = { fields, line: start };
    fields = [];
    field = "";
    wasQuoted = false;
    empty = true;
    return out;
  };
  for await (const chunk of text) {
    for (const c of chunk) {
      if (pendingCr) {
        pendingCr = false;
        if (c === "\n") continue;
      }
      if (quoted) {
        if (pendingQuote) {
          pendingQuote = false;
          if (c === '"') {
            field += '"';
            continue;
          }
          quoted = false;
        } else {
          if (c === '"') pendingQuote = true;
          else {
            if (c === "\n") line++;
            field += c;
          }
          continue;
        }
      }
      if (c === "\r" || c === "\n") {
        if (c === "\r") pendingCr = true;
        if (!empty || fields.length || field || wasQuoted) yield end();
        line++;
        start = line;
        continue;
      }
      if (empty) {
        empty = false;
        start = line;
      }
      if (c === ",") {
        fields.push(field);
        field = "";
        wasQuoted = false;
      } else if (c === '"' && field === "" && !wasQuoted) {
        quoted = true;
        wasQuoted = true;
      } else field += c;
    }
  }
  if (!empty || fields.length || field || wasQuoted) yield end();
}

async function* csvRows(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<RawRow> {
  const records = csvRecords(
    utf8(bytes, () => new ImportError("CsvInvalidRow", "Failed to parse CSV row 1: invalid UTF-8")),
  );
  // An empty file has an empty header, and no rows (Convex's `CsvMissingHeaders` never happens).
  const first = await records.next();
  const header = (first.done ? [] : first.value.fields).map((h, i) => {
    // The `csv` crate drops a leading BOM from the header.
    const name = (i === 0 ? h.replace(/^﻿/, "") : h).replace(/^ +| +$/g, "");
    try {
      validateObjectField(name);
    } catch (e) {
      throw new ImportError(
        "CsvInvalidHeader",
        `CSV header ${JSON.stringify(name)} isn't a valid field name: ${(e as Error).message}`,
      );
    }
    return name;
  });
  for await (const r of records) {
    if (r.fields.length !== header.length)
      throw new ImportError("CsvRowMissingFields", `CSV row ${r.line} doesn't have all of the fields in the header`);
    const obj: Record<string, unknown> = {};
    for (const [i, h] of header.entries()) obj[h] = parseCsvCell(r.fields[i]!);
    yield { json: obj };
  }
}

// ---------------------------------------------------------------- values

const truncate = (json: unknown) => {
  const s = JSON.stringify(json) ?? "null";
  return Buffer.byteLength(s) <= 100 ? s : `${Buffer.from(s).subarray(0, 100).toString()}...`;
};

function inferValue(json: unknown): Value {
  if (json === null || typeof json === "boolean" || typeof json === "string") return json;
  if (typeof json === "number") return json;
  if (Array.isArray(json)) return json.map(inferValue);
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    validateObjectField(k);
    out[k] = inferValue(v);
  }
  return out;
}

/**
 * A row as the document to insert (Convex's `GeneratedSchema::apply`): an object, decoded losslessly for a
 * `"uniform"` table, else as plain JSON. `n` counts rows from 1, for the messages.
 */
export function rowToDocument(row: RawRow, uniform: boolean, n: number): Record<string, Value> {
  const bad = (msg: string) => new ImportError("InvalidConvexValue", `Row ${n} wasn't a valid Convex value: ${msg}`);
  if (!isSimpleObject(row.json)) throw bad(`expected object, received ${truncate(row.json)}`);
  try {
    const v = uniform && row.text !== undefined ? fromExportJson(row.text) : inferValue(row.json);
    return v as Record<string, Value>;
  } catch (e) {
    throw bad((e as Error).message);
  }
}

// ---------------------------------------------------------------- files

/** Read one import file: the bytes of the whole upload (again for each pass), or the ZIP reader. */
export function parseSingleTable(
  format: Exclude<ImportFormat, { format: "zip" }>,
  body: () => Promise<AsyncIterable<Uint8Array>>,
): ParsedImport {
  const rows = async function* (): AsyncGenerator<RawRow> {
    const bytes = await body();
    if (format.format === "csv") yield* csvRows(bytes);
    else if (format.format === "jsonl") yield* jsonLines(refuseBom(bytes));
    else {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const b of bytes) {
        chunks.push(b);
        size += b.length;
        if (size > JSON_ARRAY_MAX_BYTES) break;
      }
      const buf = Buffer.concat(chunks).subarray(0, JSON_ARRAY_MAX_BYTES + 1);
      if (buf.length > JSON_ARRAY_MAX_BYTES)
        throw new ImportError(
          "JsonArrayTooLarge",
          `Import is too large for JSON (${buf.length} bytes > maximum 16 MiB). Consider converting data to JSONLines`,
        );
      if (BOM.every((x, i) => buf[i] === x))
        throw new ImportError("Utf8BomNotSupported", "UTF-8 BOM is not supported. Please save your file without BOM.");
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf));
      } catch (e) {
        throw new ImportError("NotJson", `Not valid JSON: ${(e as Error).message}`);
      }
      if (!Array.isArray(json)) throw new ImportError("NotJsonArray", "Not a JSON array");
      for (const v of json) yield { json: v };
    }
  };
  return { tables: [{ name: format.table, rows, uniform: false }], storageFiles: [] };
}

const DOCUMENTS = /^(.*\/)?([^/]+)\/documents\.jsonl$/;
const GENERATED_SCHEMA = /^(.*\/)?([^/]+)\/generated_schema\.jsonl$/;
const STORAGE_FILE = /(.*\/)?_storage\/([^/.]+)(?:\.[^/]+)?$/;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function tableNameOf(name: string): string {
  if (!TABLE_NAME.test(name) || !/[A-Za-z0-9]/.test(name))
    throw new ImportError("InvalidTableName", `table name '${name}' invalid: not a valid table name`);
  return name;
}

/** Components are refused (DV-215): bunvex has none yet. */
function refuseComponents(prefix: string | undefined, file: string) {
  if (prefix && /(^|\/)_components\/[^/]+\/$/.test(prefix))
    throw new ImportError(
      "ComponentsNotSupported",
      `${file} belongs to a component, and bunvex does not have components yet. Import a snapshot of an app without components.`,
    );
}

/** A snapshot ZIP's tables (in the archive's order) and files. */
export async function parseZip(zip: ZipReader): Promise<ParsedImport> {
  const tables: ImportTable[] = [];
  const uniform = new Set<string>();
  /** Tables in the legacy inferred-schema encoding (DV-219): refused at their first document. */
  const legacy = new Map<string, string>();
  const storageFiles: ParsedImport["storageFiles"] = [];
  for (const entry of zip.entries) {
    const docs = DOCUMENTS.exec(entry.name);
    if (docs) {
      refuseComponents(docs[1], entry.name);
      const name = tableNameOf(docs[2]!);
      // System tables other than `_tables` and `_storage` are not imported.
      if (name.startsWith("_") && name !== "_tables" && name !== "_storage") continue;
      tables.push({
        name,
        uniform: false,
        rows: async function* () {
          let n = 0;
          for await (const line of lines(utf8(zip.read(entry), notUtf8))) {
            n++;
            const schemaFile = legacy.get(name);
            if (schemaFile !== undefined)
              throw new ImportError(
                "InvalidGeneratedSchema",
                `cannot parse ${schemaFile}: only the "uniform" encoding of current snapshot exports can be imported`,
              );
            let json: unknown;
            try {
              json = JSON.parse(line);
            } catch (e) {
              throw new ImportError("JsonInvalidRow", `Row ${n} wasn't valid JSON: ${(e as Error).message}`);
            }
            yield { json, text: line };
          }
        },
      });
      continue;
    }
    const gs = GENERATED_SCHEMA.exec(entry.name);
    if (gs) {
      refuseComponents(gs[1], entry.name);
      const name = tableNameOf(gs[2]!);
      let first = "";
      for await (const line of lines(utf8(zip.read(entry), notUtf8))) {
        first = line;
        break;
      }
      let json: unknown;
      try {
        json = JSON.parse(first);
      } catch (e) {
        throw new ImportError("JsonInvalidRow", `Row 1 wasn't valid JSON: ${(e as Error).message}`);
      }
      if (json === "uniform") uniform.add(name);
      else legacy.set(name, entry.name);
      continue;
    }
    const file = STORAGE_FILE.exec(entry.name);
    if (file && file[2] !== "documents") {
      refuseComponents(file[1], entry.name);
      storageFiles.push({ id: file[2]!, read: () => zip.read(entry) });
    }
  }
  for (const t of tables) t.uniform = uniform.has(t.name);
  return { tables, storageFiles };
}

export { InvalidZipError };

// ---------------------------------------------------------------- the confirmation summary

export type TableChange = { table: string; added: number; deleted: number; existing: number; unit: string };

const commas = (n: number) => n.toLocaleString("en-US");

/** Convex's `render_table_changes`: a padded `table | create | delete |` table under a dash line. */
export function renderTableChanges(changes: TableChange[]): string[] {
  const parts: [string, string, string][] = [["table", "create", "delete"]];
  for (const c of changes)
    parts.push([c.table, commas(c.added), `${commas(c.deleted)} of ${commas(c.existing)}${c.unit}`]);
  const w = [0, 1, 2].map((i) => Math.max(...parts.map((p) => p[i]!.length)));
  const out: string[] = [];
  for (const [i, p] of parts.entries()) {
    out.push(`${p[0].padEnd(w[0]!)} | ${p[1].padEnd(w[1]!)} | ${p[2].padEnd(w[2]!)} |`);
    if (i === 0) out.push("-".repeat(w[0]! + 3 + w[1]! + 3 + w[2]! + 2));
  }
  return out;
}

export const CONFIRMATION_TRAILER =
  "Once the import has started, it will run in the background.\nInterrupting `bunvex import` will not cancel it.";

/** The message to confirm (Convex's `info_message_for_import`). */
export function confirmationMessage(changes: TableChange[]): string {
  const lines = changes.length ? ["Import change summary:", ...renderTableChanges(changes)] : [];
  lines.push(CONFIRMATION_TRAILER);
  return lines.join("\n");
}

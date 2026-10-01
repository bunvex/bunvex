// The mock's snapshots (UI-01 §19.2): exports that are requested, run a step per table, then wait as a zip in
// Convex's layout (`<table>/documents.jsonl`, `_tables/documents.jsonl`, and `_storage/…` with the files);
// imports that are parsed, wait for confirmation with what changes, then write a table per step — with
// `npx convex import`'s formats and modes. Not part of the contract: the mock wires it to the methods.
import {
  DataSourceError,
  type Document,
  type SnapshotExport,
  type SnapshotImport,
  type SnapshotImportFormat,
  type SnapshotImportRequest,
  type Value,
} from "../data-source.ts";
import type { MockFiles } from "./files.ts";
import { type FixtureTable, SYSTEM_INDEXES } from "./fixture.ts";
import type { Random } from "./random.ts";
import { readZip, writeZip } from "./zip.ts";

/** How long an export stays downloadable (Convex's default expiration). */
const EXPORT_LIFETIME_MS = 14 * 86_400_000;

export type SnapshotHost = {
  tables: Map<string, FixtureTable>;
  files: MockFiles;
  rnd: Random;
  now: () => number;
  record: (action: string, metadata: Record<string, Value>) => void;
  changed: (table: string) => void;
  /** Between two steps of an export or an import. */
  stepMs: number;
};

type Parsed = { table: string; documents: Record<string, Value>[] }[];

const enc = new TextEncoder();
const dec = new TextDecoder();
const jsonl = (docs: unknown[]) => enc.encode(docs.map((d) => `${JSON.stringify(d)}\n`).join(""));

export class MockSnapshots {
  private latest: (SnapshotExport & { zip?: Uint8Array<ArrayBuffer> }) | null = null;
  private readonly imports = new Map<string, SnapshotImport & { parsed?: Parsed }>();

  constructor(private readonly host: SnapshotHost) {}

  // ---------------------------------------------------------------- export

  latestExport(): SnapshotExport | null {
    if (!this.latest) return null;
    const { zip: _, ...e } = this.latest;
    return { ...e };
  }

  requestExport(includeStorage: boolean): SnapshotExport {
    const h = this.host;
    const e: SnapshotExport & { zip?: Uint8Array<ArrayBuffer> } = {
      id: h.rnd.id(),
      state: "requested",
      requestedAt: h.now(),
      includeStorage,
    };
    this.latest = e;
    h.record("request_export", { format: "zip", include_storage: includeStorage });
    const tables = [...h.tables.keys()].sort();
    const step = (i: number) => {
      if (this.latest !== e) return; // replaced by a newer request
      if (i < tables.length) {
        e.state = "in_progress";
        e.progress = `Exporting ${tables[i]} (${i + 1} of ${tables.length} tables)`;
        setTimeout(() => step(i + 1), h.stepMs);
        return;
      }
      void this.buildZip(includeStorage).then(
        (zip) => {
          if (this.latest !== e) return;
          e.zip = zip;
          e.state = "completed";
          e.progress = undefined;
          e.completedAt = h.now();
          e.expiresAt = e.completedAt + EXPORT_LIFETIME_MS;
          e.size = zip.length;
        },
        (err: unknown) => {
          e.state = "failed";
          e.error = err instanceof Error ? err.message : String(err);
        },
      );
    };
    setTimeout(() => step(0), h.stepMs);
    return this.latestExport()!;
  }

  download(id: string): Blob {
    const e = this.latest;
    if (!e || e.id !== id) throw new DataSourceError("not_found", "no such export: only the latest one is kept");
    if (e.state !== "completed" || !e.zip)
      throw new DataSourceError("invalid_request", "the export is not completed yet");
    if (e.expiresAt !== undefined && this.host.now() > e.expiresAt)
      throw new DataSourceError("invalid_request", "the export has expired: request a new one");
    return new Blob([e.zip as Uint8Array<ArrayBuffer>], { type: "application/zip" });
  }

  private async buildZip(includeStorage: boolean): Promise<Uint8Array<ArrayBuffer>> {
    const h = this.host;
    const tables = [...h.tables.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    const entries = [
      {
        name: "README.md",
        data: enc.encode(
          "# Snapshot\n\nOne folder per table, with its documents as JSON Lines. Import it from the dashboard " +
            "(Settings → Snapshots).\n",
        ),
      },
      { name: "_tables/documents.jsonl", data: jsonl(tables.map((t) => ({ name: t.name }))) },
      ...tables.map((t) => ({ name: `${t.name}/documents.jsonl`, data: jsonl(t.documents) })),
    ];
    if (includeStorage) {
      const files = [];
      for (let cursor: string | null = null; ; ) {
        const page = await h.files.list({ numItems: 100, cursor });
        files.push(...page.page);
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      entries.push({
        name: "_storage/documents.jsonl",
        data: jsonl(
          files.map((f) => ({
            _id: f.id,
            _creationTime: f.creationTime,
            sha256: f.sha256,
            size: f.size,
            contentType: f.contentType,
          })),
        ),
      });
      for (const f of files) {
        const blob = await h.files.blob(f.id);
        if (blob) entries.push({ name: `_storage/${f.id}`, data: new Uint8Array(await blob.arrayBuffer()) });
      }
    }
    return writeZip(entries);
  }

  // ---------------------------------------------------------------- import

  getImport(id: string): SnapshotImport {
    const i = this.imports.get(id);
    if (!i) throw new DataSourceError("not_found", `no import ${id}`);
    const { parsed: _, ...rest } = i;
    return structuredClone(rest);
  }

  async start(req: SnapshotImportRequest): Promise<SnapshotImport> {
    const h = this.host;
    const imp: SnapshotImport & { parsed?: Parsed } = {
      id: h.rnd.id(),
      state: "uploaded",
      format: req.format,
      mode: req.mode,
    };
    this.imports.set(imp.id, imp);
    try {
      if (!(req.file instanceof Blob)) throw new Error("the file must be a Blob or a File");
      if (req.format === "zip" && req.table)
        throw new Error("a table cannot be named for a zip: its folders name them");
      if (req.format !== "zip" && !req.table) throw new Error(`a table is needed for the ${req.format} format`);
      if (req.mode === "replaceAll" && req.format !== "zip")
        throw new Error("replacing everything takes a zip snapshot: name a mode for one table");
      const parsed = await parseFile(req);
      if (parsed.length === 0) throw new Error("the zip has no table: no <table>/documents.jsonl in it");
      for (const p of parsed) {
        const problem = tableNameProblem(p.table);
        if (problem) throw new Error(problem);
      }
      imp.changes = this.changesFor(parsed, req);
      imp.parsed = parsed;
      imp.state = "waiting_for_confirmation";
    } catch (e) {
      imp.state = "failed";
      imp.error = e instanceof Error ? e.message : String(e);
    }
    return this.getImport(imp.id);
  }

  private changesFor(parsed: Parsed, req: SnapshotImportRequest): SnapshotImport["changes"] {
    const h = this.host;
    const changes = parsed.map((p) => {
      const existing = h.tables.get(p.table)?.documents ?? [];
      if (req.mode === "requireEmpty" && existing.length > 0)
        throw new Error(
          `${p.table} already has ${existing.length} document${existing.length === 1 ? "" : "s"}: import with "append" or "replace"`,
        );
      if (req.mode === "append") {
        const ids = new Set(existing.map((d) => d._id));
        const clash = p.documents.find((d) => typeof d._id === "string" && ids.has(d._id));
        if (clash) throw new Error(`${p.table} already has a document ${String(clash._id)}`);
      }
      const seen = new Set<string>();
      for (const d of p.documents)
        if (typeof d._id === "string") {
          if (seen.has(d._id)) throw new Error(`${p.table}: the id ${d._id} appears twice`);
          seen.add(d._id);
        }
      return {
        table: p.table,
        add: p.documents.length,
        delete: req.mode === "replace" || req.mode === "replaceAll" ? existing.length : 0,
      };
    });
    if (req.mode === "replaceAll")
      for (const t of h.tables.values())
        if (!parsed.some((p) => p.table === t.name) && t.documents.length > 0)
          changes.push({ table: t.name, add: 0, delete: t.documents.length });
    return changes.sort((a, b) => (a.table < b.table ? -1 : 1));
  }

  confirm(id: string) {
    const h = this.host;
    const imp = this.imports.get(id);
    if (!imp) throw new DataSourceError("not_found", `no import ${id}`);
    if (imp.state !== "waiting_for_confirmation")
      throw new DataSourceError(
        "invalid_request",
        `the import is ${imp.state.replaceAll("_", " ")}, not waiting for confirmation`,
      );
    const parsed = imp.parsed!;
    imp.state = "in_progress";
    imp.checkpoints = [];
    imp.rowsWritten = 0;
    const emptied = imp.mode === "replaceAll" ? (imp.changes ?? []).filter((c) => c.add === 0).map((c) => c.table) : [];
    const steps: (() => void)[] = [
      ...parsed.map((p) => () => {
        imp.progress = `Importing ${p.table}`;
        const t = this.tableFor(p.table);
        if (imp.mode !== "append") t.documents = [];
        let last = t.documents.reduce((m, d) => Math.max(m, d._creationTime), 0);
        const now = h.now();
        for (const d of p.documents) {
          if (typeof d._creationTime !== "number") last = Math.max(now, last + 0.001);
          const _creationTime = typeof d._creationTime === "number" ? d._creationTime : last;
          const _id = typeof d._id === "string" ? d._id : h.rnd.id();
          t.documents.push({ ...d, _id, _creationTime } as Document);
        }
        t.documents.sort((a, b) => a._creationTime - b._creationTime);
        imp.rowsWritten! += p.documents.length;
        imp.checkpoints!.push(
          `Imported ${p.documents.length} document${p.documents.length === 1 ? "" : "s"} into ${p.table}`,
        );
        h.changed(p.table);
      }),
      ...emptied.map((name) => () => {
        const t = h.tables.get(name)!;
        const n = t.documents.length;
        t.documents = [];
        imp.checkpoints!.push(`Deleted ${n} document${n === 1 ? "" : "s"} from ${name}`);
        h.changed(name);
      }),
    ];
    const run = (i: number) => {
      if (i < steps.length) {
        steps[i]!();
        setTimeout(() => run(i + 1), h.stepMs);
        return;
      }
      imp.state = "completed";
      imp.progress = undefined;
      imp.parsed = undefined;
      h.record("snapshot_import", {
        table_names: parsed.map((p) => p.table),
        import_format: imp.format,
        import_mode: imp.mode,
        count: imp.rowsWritten ?? 0,
      });
    };
    setTimeout(() => run(0), h.stepMs);
  }

  cancel(id: string) {
    const imp = this.imports.get(id);
    if (!imp) throw new DataSourceError("not_found", `no import ${id}`);
    if (imp.state !== "waiting_for_confirmation")
      throw new DataSourceError("invalid_request", "only an import waiting for confirmation can be canceled");
    imp.state = "failed";
    imp.error = "Canceled before it started.";
    imp.parsed = undefined;
  }

  private tableFor(name: string): FixtureTable {
    let t = this.host.tables.get(name);
    if (!t) {
      t = { name, indexes: structuredClone(SYSTEM_INDEXES), documents: [], declared: false };
      this.host.tables.set(name, t);
    }
    return t;
  }
}

// ------------------------------------------------------------------ parsing

function tableNameProblem(name: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
    return `"${name}" is not a table name: letters, digits or underscores, starting with a letter`;
}

function documentOf(v: unknown, where: string): Record<string, Value> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${where}: a document is a JSON object`);
  for (const k of Object.keys(v))
    if (k.startsWith("_") && k !== "_id" && k !== "_creationTime")
      throw new Error(`${where}: "${k}" — field names cannot start with an underscore`);
  return v as Record<string, Value>;
}

function parseJsonLines(text: string, where: string): Record<string, Value>[] {
  const out: Record<string, Value>[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") return;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      throw new Error(`${where}, line ${i + 1}: not valid JSON`);
    }
    out.push(documentOf(v, `${where}, line ${i + 1}`));
  });
  return out;
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF. Numbers and booleans are read as such; empty cells are left out. */
export function parseCsv(text: string): Record<string, Value>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  if (!header) return [];
  return body.map((r, n) => {
    const doc: Record<string, Value> = {};
    header.forEach((name, i) => {
      const raw = r[i] ?? "";
      if (raw === "") return;
      doc[name] = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)
        ? Number(raw)
        : raw === "true"
          ? true
          : raw === "false"
            ? false
            : raw;
    });
    return documentOf(doc, `row ${n + 2}`);
  });
}

async function parseFile(req: SnapshotImportRequest): Promise<Parsed> {
  const format: SnapshotImportFormat = req.format;
  if (format === "zip") {
    let entries: Awaited<ReturnType<typeof readZip>>;
    try {
      entries = await readZip(new Uint8Array(await req.file.arrayBuffer()));
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
    return entries
      .map((e) => ({ e, m: /^([^/]+)\/documents\.jsonl$/.exec(e.name) }))
      .filter(({ m }) => m && !m[1]!.startsWith("_"))
      .map(({ e, m }) => ({ table: m![1]!, documents: parseJsonLines(dec.decode(e.data), e.name) }))
      .sort((a, b) => (a.table < b.table ? -1 : 1));
  }
  const text = await req.file.text();
  const table = req.table!;
  if (format === "jsonLines") return [{ table, documents: parseJsonLines(text, "the file") }];
  if (format === "csv") return [{ table, documents: parseCsv(text) }];
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("the file is not valid JSON");
  }
  if (!Array.isArray(v)) throw new Error("a JSON array import takes an array of documents");
  return [{ table, documents: v.map((d, i) => documentOf(d, `item ${i + 1}`)) }];
}

// Data sync (STUDY-69), Convex's `/api/v1/data/sync` (crates/streaming_export, crates/table_iteration
// `data_sync.rs`, local_backend/src/streaming_export.rs), the API the Fivetran connector uses: each call
// returns one page and a cursor. The sync first walks each selected table by id at one timestamp (a by-id
// page), catching up along the document log when that timestamp is more than 30 s behind (a ts page), then
// follows the log. The cursor is Convex's: a `DataSyncCursor` protobuf sealed with AES-128-GCM-SIV under the
// deployment's "data sync cursor" key, in hex. Progress is kept in `_data_sync_progress`.
import { randomBytes } from "node:crypto";
import {
  aes128GcmSivOpen,
  aes128GcmSivSeal,
  type Caller,
  DATA_SYNC_PROGRESS_TABLE,
  type Engine,
  hasRetention,
  insertAuditLogEvents,
  OutOfRetentionError,
  type TableDef,
  type Tx,
} from "@bunvex/core";
import { decodeId, encodeId, fromJsonValue, type JSONValue, type Value } from "@bunvex/values";
import { auditActor } from "./audit-log.ts";
import {
  type Columns,
  pickColumns,
  type Selection,
  StreamingExportError,
  selectionOf,
  streamedTables,
  tableSelection,
  writeValue,
} from "./streaming-export.ts";

/** Convex's knobs (common/src/knobs.rs). */
export const DATA_SYNC_LIMITS = {
  pageSize: Number(process.env.DATA_SYNC_PAGE_SIZE_LIMIT ?? 16384),
  pageBytes: Number(process.env.DATA_SYNC_PAGE_BYTES_LIMIT ?? 1 << 26),
  maxRowsRead: Number(process.env.DATA_SYNC_MAX_ROWS_READ ?? 32768),
  byIdFreshnessUs: Number(process.env.DATA_SYNC_BY_ID_FRESHNESS_SECONDS ?? 30) * 1_000_000,
  progressWriteIntervalMs: Number(process.env.DATA_SYNC_PROGRESS_WRITE_INTERVAL_MS ?? 5000),
};
export type DataSyncLimits = typeof DATA_SYNC_LIMITS;
/** Convex's `DATA_SYNC_ACTIVE_WINDOW`: a sync is active for 3 days after its last page. */
const ACTIVE_WINDOW_MS = 3 * 24 * 3600 * 1000;

const bad = (code: string, message: string) => new StreamingExportError(400, code, message);
const expired = () =>
  bad(
    "DataSyncCursorExpired",
    "The cursor is outside the deployment's data retention window and can no longer be resumed. Restart the sync from scratch by calling /data/sync without a cursor.",
  );

// ---------------------------------------------------------------- the cursor (Convex's protobuf)

type TabletRef = { tablet: number; component: string; table: string };
type InProgress = TabletRef & { currentId: string | null; docsSynced: number };
export type DataSyncCursor = {
  /** Microseconds (the wire has Convex's nanoseconds). */
  syncedTs: number;
  synced: TabletRef[];
  /** The table being walked by id; null once every table is synced (Convex's `Synced`). */
  current: InProgress | null;
  syncId: string;
  numDocsSynced: number;
};

/** Convex's `DATA_SYNC_CURSOR_VERSION`. */
const CURSOR_VERSION = 1;

function varint(n: bigint): number[] {
  const out: number[] = [];
  let x = n;
  while (x >= 0x80n) {
    out.push(Number(x & 0x7fn) | 0x80);
    x >>= 7n;
  }
  out.push(Number(x));
  return out;
}

class ProtoWriter {
  bytes: number[] = [];
  uint(field: number, n: bigint | number) {
    this.bytes.push(...varint(BigInt(field << 3)), ...varint(BigInt(n)));
    return this;
  }
  lenDelimited(field: number, data: Uint8Array | number[]) {
    this.bytes.push(...varint(BigInt((field << 3) | 2)), ...varint(BigInt(data.length)), ...data);
    return this;
  }
  string(field: number, s: string) {
    return this.lenDelimited(field, Buffer.from(s, "utf8"));
  }
  done() {
    return Uint8Array.from(this.bytes);
  }
}

/** A message's fields by number: varints as bigint, length-delimited as bytes (repeated ones in order). */
function readProto(buf: Uint8Array): Map<number, (bigint | Uint8Array)[]> {
  const fields = new Map<number, (bigint | Uint8Array)[]>();
  let i = 0;
  const readVarint = () => {
    let x = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error("truncated varint");
      const b = buf[i++]!;
      x |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return x;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const tag = Number(readVarint());
    const field = tag >> 3;
    const wire = tag & 7;
    let value: bigint | Uint8Array;
    if (wire === 0) value = readVarint();
    else if (wire === 2) {
      const len = Number(readVarint());
      if (i + len > buf.length) throw new Error("truncated field");
      value = buf.subarray(i, i + len);
      i += len;
    } else throw new Error(`unsupported wire type ${wire}`);
    const list = fields.get(field) ?? [];
    list.push(value);
    fields.set(field, list);
  }
  return fields;
}

/** A bunvex tablet as Convex's 16-byte `TabletId` (big-endian). */
const tabletBytes = (tablet: number) => {
  const b = new Uint8Array(16);
  new DataView(b.buffer).setBigUint64(8, BigInt(tablet));
  return b;
};
const tabletOf = (b: Uint8Array) => {
  if (b.length !== 16) throw new Error("bad tablet id");
  return Number(new DataView(b.buffer, b.byteOffset, 16).getBigUint64(8));
};

function encodeTablet(t: TabletRef, extra?: (w: ProtoWriter) => void) {
  const w = new ProtoWriter().lenDelimited(1, tabletBytes(t.tablet)).string(2, t.component).string(3, t.table);
  extra?.(w);
  return w.done();
}

export function encodeCursor(c: DataSyncCursor): Uint8Array {
  const w = new ProtoWriter().uint(1, BigInt(c.syncedTs) * 1000n);
  for (const t of c.synced) w.lenDelimited(2, encodeTablet(t));
  if (c.current === null) w.lenDelimited(3, []);
  else {
    const cur = c.current;
    w.lenDelimited(
      4,
      encodeTablet(cur, (iw) => {
        if (cur.currentId !== null) {
          const d = decodeId(cur.currentId);
          iw.lenDelimited(4, new ProtoWriter().uint(1, d.tableNumber).lenDelimited(2, d.internalId).done());
        }
        iw.uint(5, cur.docsSynced);
      }),
    );
  }
  w.string(5, c.syncId).uint(6, c.numDocsSynced);
  return w.done();
}

export function decodeCursor(buf: Uint8Array): DataSyncCursor {
  const f = readProto(buf);
  const one = (m: Map<number, (bigint | Uint8Array)[]>, n: number) => m.get(n)?.at(-1);
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`missing ${what}`);
    return v;
  };
  const str = (v: bigint | Uint8Array | undefined, what: string) =>
    Buffer.from(need(v, what) as Uint8Array).toString("utf8");
  const tablet = (b: Uint8Array): TabletRef & { m: Map<number, (bigint | Uint8Array)[]> } => {
    const m = readProto(b);
    return {
      tablet: tabletOf(need(one(m, 1), "tablet_id") as Uint8Array),
      component: str(one(m, 2), "component_path"),
      table: str(one(m, 3), "table_name"),
      m,
    };
  };
  const syncedTs = Number((need(one(f, 1), "synced_ts") as bigint) / 1000n);
  const synced = (f.get(2) ?? []).map((b) => {
    const { m: _, ...t } = tablet(b as Uint8Array);
    return t;
  });
  let current: InProgress | null;
  if (f.has(4)) {
    const { m, ...t } = tablet(one(f, 4) as Uint8Array);
    const idMsg = one(m, 4) as Uint8Array | undefined;
    let currentId: string | null = null;
    if (idMsg !== undefined) {
      const im = readProto(idMsg);
      currentId = encodeId(
        Number(need(one(im, 1), "table_number") as bigint),
        need(one(im, 2), "internal_id") as Uint8Array,
      );
    }
    current = { ...t, currentId, docsSynced: Number((one(m, 5) as bigint | undefined) ?? 0n) };
  } else if (f.has(3)) current = null;
  else throw new Error("missing table_cursor");
  return {
    syncedTs,
    synced,
    current,
    syncId: str(one(f, 5), "sync_id"),
    numDocsSynced: Number((one(f, 6) as bigint | undefined) ?? 0n),
  };
}

/** Convex's `RandomEncryptor`: `hex(version ‖ nonce(12) ‖ AES-128-GCM-SIV(plaintext, aad = [version]))`. */
export function sealCursor(engine: Engine, c: DataSyncCursor): string {
  const nonce = new Uint8Array(randomBytes(12));
  const sealed = aes128GcmSivSeal(
    engine.derivedKey("data sync cursor"),
    nonce,
    Uint8Array.of(CURSOR_VERSION),
    encodeCursor(c),
  );
  return Buffer.concat([Uint8Array.of(CURSOR_VERSION), nonce, sealed]).toString("hex");
}

export function openCursor(engine: Engine, hex: string): DataSyncCursor {
  const invalid = () => bad("InvalidDataSyncCursor", "Could not parse the data sync cursor");
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw invalid();
  const b = Buffer.from(hex, "hex");
  if (b.length < 1 + 12 + 16 || b[0] !== CURSOR_VERSION) throw invalid();
  try {
    const plain = aes128GcmSivOpen(
      engine.derivedKey("data sync cursor"),
      b.subarray(1, 13),
      Uint8Array.of(CURSOR_VERSION),
      b.subarray(13),
    );
    if (plain === null) throw invalid();
    return decodeCursor(plain);
  } catch {
    throw invalid();
  }
}

// ---------------------------------------------------------------- the client and the sync id

/**
 * The sync id's prefix from the client header (Convex's `DataSyncClient`): `fivetran-` for the Fivetran
 * connector (`fivetran-export-x.y.z` / `fivetran-import-…`), `airbyte-` for Airbyte's, none otherwise. Convex's
 * header name is allowed by rule 5's wire-name exception (STUDY-69); bunvex's own works too.
 */
export function clientPrefix(req: Request): string {
  const header = req.headers.get("convex-client") ?? req.headers.get("bunvex-client");
  if (header === null) return "";
  const parts = header.split("-");
  if (parts.length < 2) throw bad("InvalidClientVersion", `Invalid client version: ${header}`);
  // `<client>-<semver>`: the client is everything before the longest semver suffix.
  const m = /^(.*)-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(header);
  const client = m ? m[1]! : "";
  if (client === "fivetran-export" || client === "fivetran-import") return "fivetran-";
  if (client === "airbyte-export") return "airbyte-";
  return "";
}

// ---------------------------------------------------------------- one page

type Target = { t: TableDef; cols: Columns };
export type DataSyncValue = { table: string; ts: number; deleted: boolean; json: string };
export type DataSyncStatus =
  | { type: "snapshotting" }
  | { type: "stale"; snapshotTs: number }
  | { type: "upToDate"; snapshotTs: number };
export type DataSyncPage = {
  status: DataSyncStatus;
  truncates: string[];
  values: DataSyncValue[];
  cursor: DataSyncCursor;
  targets: Target[];
};

/** The selected tables (active and hidden user tables), by tablet, and their columns. */
export function dataSyncTargets(engine: Engine, selection: Selection): Target[] {
  const out: Target[] = [];
  for (const t of streamedTables(engine)) {
    let cols: Columns | null;
    try {
      cols = tableSelection(selection, t.name);
    } catch (e) {
      throw bad("InvalidDataSyncSelection", `Invalid selection: ${(e as Error).message}`);
    }
    if (cols) out.push({ t, cols });
  }
  return out;
}

const ref = (t: TableDef): TabletRef => ({ tablet: t.id, component: "", table: t.name });
/** Ids in `by_id`'s order (the walk's): the id strings' byte order (ASCII). */
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Convex's reconcile: forget tables no longer selected, start the next one not yet synced. */
function reconcile(c: DataSyncCursor, targets: Target[]): DataSyncCursor {
  const targeted = new Set(targets.map((x) => x.t.id));
  const synced = c.synced.filter((s) => targeted.has(s.tablet));
  let current = c.current;
  const nextUnsynced = () => {
    const done = new Set(synced.map((s) => s.tablet));
    const next = targets.find((x) => !done.has(x.t.id));
    return next ? { ...ref(next.t), currentId: null, docsSynced: 0 } : null;
  };
  if (current !== null && !targeted.has(current.tablet)) current = nextUnsynced();
  else if (current === null) current = nextUnsynced();
  return { ...c, synced, current };
}

function statusOf(c: DataSyncCursor, latest: number): DataSyncStatus {
  if (c.current !== null) return { type: "snapshotting" };
  return c.syncedTs < latest ? { type: "stale", snapshotTs: c.syncedTs } : { type: "upToDate", snapshotTs: c.syncedTs };
}

const docValue = (json: string, cols: Columns) =>
  writeValue(pickColumns(fromJsonValue(JSON.parse(json) as JSONValue) as Record<string, Value>, cols), "export");

/** One page of a data sync: Convex's `DataSyncIterator::next_page`. */
export async function dataSyncPage(
  engine: Engine,
  input: DataSyncCursor | null,
  selection: Selection,
  newSyncId: () => string,
  limits: DataSyncLimits = DATA_SYNC_LIMITS,
): Promise<DataSyncPage> {
  const latest = engine.committer.visibleTs;
  const targets = dataSyncTargets(engine, selection);
  const byTablet = new Map(targets.map((x) => [x.t.id, x]));
  if (input !== null && input.syncedTs > latest)
    throw bad("InvalidDataSyncCursor", "data sync cursor is ahead of the deployment's latest timestamp");
  const trackedBefore = new Set(
    input === null ? [] : [...input.synced.map((s) => s.tablet), ...(input.current ? [input.current.tablet] : [])],
  );
  let c: DataSyncCursor = reconcile(
    input ?? { syncedTs: latest, synced: [], current: null, syncId: newSyncId(), numDocsSynced: 0 },
    targets,
  );
  const values: DataSyncValue[] = [];
  try {
    if (c.current !== null && latest - c.syncedTs < limits.byIdFreshnessUs)
      c = await byIdPage(engine, c, byTablet, values, limits);
    else c = await tsPage(engine, c, latest, byTablet, values, limits);
  } catch (e) {
    if (e instanceof OutOfRetentionError) throw expired();
    throw e;
  }
  const names = new Set<string>();
  for (const t of [...c.synced, ...(c.current ? [c.current] : [])])
    if (!trackedBefore.has(t.tablet)) names.add(t.table);
  return { status: statusOf(c, latest), truncates: [...names].sort(), values, cursor: c, targets };
}

async function byIdPage(
  engine: Engine,
  c: DataSyncCursor,
  byTablet: Map<number, Target>,
  values: DataSyncValue[],
  limits: DataSyncLimits,
): Promise<DataSyncCursor> {
  const cur = c.current!;
  const target = byTablet.get(cur.tablet)!;
  const after = cur.currentId;
  const docs = (await engine.query(
    (db) =>
      db.asSystem(() =>
        db
          .queryDef(target.t)
          .withIndex("by_id", (q) => (after === null ? q : q.gt("_id", after)))
          .take(limits.pageSize),
      ),
    undefined,
    undefined,
    undefined,
    c.syncedTs,
  )) as Record<string, Value>[];
  const ids = docs.map((d) => d._id as string);
  const versions = engine.persistence.getVersions
    ? await engine.persistence.getVersions(cur.tablet, ids, c.syncedTs)
    : null;
  let bytes = 0;
  let taken = 0;
  for (const [i, d] of docs.entries()) {
    const json = writeValue(pickColumns(d, target.cols), "export");
    values.push({ table: cur.table, ts: versions?.[i]?.ts ?? c.syncedTs, deleted: false, json });
    bytes += json.length;
    taken++;
    if (bytes >= limits.pageBytes) break;
  }
  const reachedEnd = docs.length < limits.pageSize && taken === docs.length;
  const numDocsSynced = c.numDocsSynced + taken;
  if (!reachedEnd)
    return { ...c, numDocsSynced, current: { ...cur, currentId: ids[taken - 1]!, docsSynced: cur.docsSynced + taken } };
  const synced = [...c.synced, { tablet: cur.tablet, component: cur.component, table: cur.table }];
  const done = new Set(synced.map((s) => s.tablet));
  const next = [...byTablet.values()].find((x) => !done.has(x.t.id));
  return {
    ...c,
    numDocsSynced,
    synced,
    current: next ? { ...ref(next.t), currentId: null, docsSynced: 0 } : null,
  };
}

async function tsPage(
  engine: Engine,
  c: DataSyncCursor,
  latest: number,
  byTablet: Map<number, Target>,
  values: DataSyncValue[],
  limits: DataSyncLimits,
): Promise<DataSyncCursor> {
  const store = engine.persistence;
  if (!hasRetention(store)) throw new Error("this persistence has no document log");
  // The log after the cursor must still be in the document retention window.
  if (c.syncedTs + 1 < (engine.retention?.minDocumentTs ?? 0)) throw expired();
  const synced = new Set(c.synced.map((s) => s.tablet));
  const cur = c.current;
  const captured = (tablet: number, id: string) =>
    synced.has(tablet) ||
    (cur !== null && tablet === cur.tablet && cur.currentId !== null && compareIds(id, cur.currentId) <= 0);
  let after = c.syncedTs;
  let rowsRead = 0;
  let bytes = 0;
  let committedAny = false;
  let exhausted = false;
  outer: for (;;) {
    const rows = await store.readDocumentLog(after, latest, 64);
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    const commits = new Map<number, typeof rows>();
    for (const r of rows) (commits.get(r.ts) ?? commits.set(r.ts, []).get(r.ts)!).push(r);
    for (const [ts, commit] of [...commits].sort(([a], [b]) => a - b)) {
      if (
        committedAny &&
        (rowsRead >= limits.maxRowsRead || values.length >= limits.pageSize || bytes >= limits.pageBytes)
      )
        break outer;
      commit.sort((a, b) => a.table - b.table || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const out: DataSyncValue[] = [];
      let commitBytes = 0;
      const live = new Map<number, string[]>();
      for (const r of commit)
        if (!r.deleted && captured(r.table, r.id) && byTablet.has(r.table))
          live.set(r.table, [...(live.get(r.table) ?? []), r.id]);
      const docs = new Map<string, string>();
      for (const [tablet, ids] of live) {
        const vs = store.getVersions
          ? await store.getVersions(tablet, ids, ts)
          : await Promise.all(
              ids.map(async (id) => {
                const json = await store.get(tablet, id, ts);
                return json === null ? null : { json, ts };
              }),
            );
        ids.forEach((id, i) => {
          const v = vs[i];
          if (v) docs.set(`${tablet}\u0000${id}`, v.json);
        });
      }
      for (const r of commit) {
        const target = byTablet.get(r.table);
        if (!target || !captured(r.table, r.id)) continue;
        const json = r.deleted
          ? JSON.stringify({ _id: r.id })
          : (() => {
              const raw = docs.get(`${r.table}\u0000${r.id}`);
              return raw === undefined ? null : docValue(raw, target.cols);
            })();
        if (json === null) continue;
        out.push({ table: target.t.name, ts, deleted: r.deleted, json });
        commitBytes += json.length;
      }
      // A commit is never split; past the limits only a first commit is taken whole.
      if (
        committedAny &&
        (rowsRead + commit.length > limits.maxRowsRead ||
          values.length + out.length > limits.pageSize ||
          bytes + commitBytes > limits.pageBytes)
      )
        break outer;
      rowsRead += commit.length;
      bytes += commitBytes;
      values.push(...out);
      after = ts;
      committedAny = true;
    }
  }
  return { ...c, syncedTs: exhausted ? latest : after, numDocsSynced: c.numDocsSynced + values.length };
}

// ---------------------------------------------------------------- progress (`_data_sync_progress`)

type ProgressState =
  | {
      type: "Snapshotting";
      numTablesSynced: number;
      totalTables: number;
      currentComponent: string;
      currentTable: string;
      numDocumentsSyncedInCurrentTable: number;
      totalDocumentsInCurrentTable: number;
      numDocumentsSynced: number;
      totalDocuments: number;
    }
  | { type: "Stale" | "UpToDate"; totalTables: number; numDocumentsSynced: number; syncedTs: bigint };
type ProgressRow = { _id: string; syncId: string; lastUpdatedMs: number; state: ProgressState };

function progressState(engine: Engine, page: DataSyncPage): ProgressState {
  const c = page.cursor;
  if (c.current !== null) {
    const count = (tablet: number) => engine.tableSummaries.count(tablet);
    return {
      type: "Snapshotting",
      numTablesSynced: c.synced.length,
      totalTables: page.targets.length,
      currentComponent: c.current.component,
      currentTable: c.current.table,
      numDocumentsSyncedInCurrentTable: c.current.docsSynced,
      totalDocumentsInCurrentTable: count(c.current.tablet),
      numDocumentsSynced: c.numDocsSynced,
      totalDocuments: page.targets.reduce((n, x) => n + count(x.t.id), 0),
    };
  }
  return {
    type: page.status.type === "upToDate" ? "UpToDate" : "Stale",
    totalTables: c.synced.length,
    numDocumentsSynced: c.numDocsSynced,
    syncedTs: BigInt(c.syncedTs) * 1000n,
  };
}

const progressOf = (db: Tx, syncId: string) =>
  db.asSystem(() =>
    db
      .query(DATA_SYNC_PROGRESS_TABLE)
      .withIndex("by_sync_id", (q) => q.eq("syncId", syncId))
      .first(),
  ) as Promise<ProgressRow | null>;

/**
 * Convex's progress write after a page: the first one inserted with its `create_data_sync` audit event (a
 * failure fails the page), later ones best effort and only when the state's kind changed, an up-to-date
 * sync's count changed, or the interval passed.
 */
export async function recordProgress(engine: Engine, page: DataSyncPage, caller: Caller, limits = DATA_SYNC_LIMITS) {
  const now = Date.now();
  const syncId = page.cursor.syncId;
  const existing = await engine.query((db) => progressOf(db, syncId));
  let state: ProgressState;
  try {
    state = progressState(engine, page);
  } catch (e) {
    if (existing === null) throw e; // Convex: the first page needs the table counts
    return;
  }
  if (existing === null) {
    await engine.mutation(async (db) => {
      await db.asSystem(() => db.insert(DATA_SYNC_PROGRESS_TABLE, { syncId, lastUpdatedMs: now, state } as never));
      await insertAuditLogEvents(
        db,
        [{ action: "create_data_sync", metadata: { sync_id: syncId } }],
        auditActor(caller),
      );
    }, "data_sync_progress");
    return;
  }
  const changedKind = existing.state.type !== state.type;
  const countChanged = state.type === "UpToDate" && existing.state.numDocumentsSynced !== state.numDocumentsSynced;
  if (!changedKind && !countChanged && now - existing.lastUpdatedMs < limits.progressWriteIntervalMs) return;
  await engine
    .mutation(
      (db) =>
        db.asSystem(() => db.patch(DATA_SYNC_PROGRESS_TABLE, existing._id, { lastUpdatedMs: now, state } as never)),
      "data_sync_progress",
    )
    .catch((e) => console.error("data sync: recording progress failed", e));
}

/** A progress row as the API answers it (`ActiveDataSync`): camelCase kinds, Convex's field names. */
export function activeSyncJson(r: ProgressRow): string {
  const s = r.state;
  const status =
    s.type === "Snapshotting"
      ? `{"type":"snapshotting","numTablesSynced":${s.numTablesSynced},"totalTables":${s.totalTables},"currentComponent":${JSON.stringify(s.currentComponent)},"currentTable":${JSON.stringify(s.currentTable)},"numDocumentsInCurrentTable":${s.numDocumentsSyncedInCurrentTable},"totalDocumentsInCurrentTable":${s.totalDocumentsInCurrentTable},"numDocumentsSynced":${s.numDocumentsSynced},"totalDocuments":${s.totalDocuments}}`
      : `{"type":${s.type === "Stale" ? '"stale"' : '"upToDate"'},"totalTables":${s.totalTables},"numDocumentsSynced":${s.numDocumentsSynced},"syncedTs":${s.syncedTs}}`;
  return `{"syncId":${JSON.stringify(r.syncId)},"lastUpdated":${r.lastUpdatedMs},"status":${status}}`;
}

export async function activeSync(engine: Engine, syncId: string): Promise<string> {
  const row = await engine.query((db) => progressOf(db, syncId));
  if (!row || row.lastUpdatedMs < Date.now() - ACTIVE_WINDOW_MS)
    throw new StreamingExportError(
      404,
      "DataSyncNotFound",
      `No active data sync with id ${syncId}. A data sync is active for 3 days after its most recent page.`,
    );
  return activeSyncJson(row);
}

/** `list_active_syncs`: newest first, while active; paginated with an ordinary (sealed) query cursor. */
export async function listActiveSyncs(engine: Engine, q: URLSearchParams): Promise<string> {
  const raw = q.get("limit");
  let limit = 50;
  if (raw !== null) {
    if (!/^\d+$/.test(raw)) throw bad("BadQueryArgs", "limit: invalid digit found in string");
    limit = Number(raw);
  }
  if (limit < 1 || limit > 100)
    throw bad("LimitOutOfRange", "The limit for listing active syncs must be between 1 and 100");
  const cursor = q.get("cursor");
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  let page: { page: ProgressRow[]; continueCursor: string; isDone: boolean };
  try {
    page = (await engine.query((db) =>
      db.asSystem(() =>
        db
          .query(DATA_SYNC_PROGRESS_TABLE)
          .withIndex("by_last_updated")
          .order("desc")
          .paginate({ numItems: limit, cursor }),
      ),
    )) as never;
  } catch {
    throw bad("InvalidCursor", "Failed to parse cursor");
  }
  const active = page.page.filter((r) => r.lastUpdatedMs >= cutoff);
  const more = !page.isDone && active.length === page.page.length;
  return `{"syncs":[${active.map(activeSyncJson).join(",")}],"pagination":{"hasMore":${more}${more ? `,"nextCursor":${JSON.stringify(page.continueCursor)}` : ""}}}`;
}

// ---------------------------------------------------------------- the routes

export const DATA_SYNC_ROUTE =
  /^\/api\/(?:v1\/data\/(sync|list_active_syncs)(?:\/([^/]+))?|(data_sync_cursor_from_deltas))$/;

/** `POST /api/v1/data/sync` `{cursor?, selection?}`: one page. */
export async function dataSync(engine: Engine, req: Request, caller: Caller): Promise<string> {
  const body = await jsonBody(req);
  const prefix = clientPrefix(req);
  const selection = selectionArg(body.selection);
  const input =
    body.cursor === undefined || body.cursor === null
      ? null
      : typeof body.cursor === "string"
        ? openCursor(engine, body.cursor)
        : (() => {
            throw bad("InvalidDataSyncCursor", "Could not parse the data sync cursor");
          })();
  const page = await dataSyncPage(engine, input, selection, () => `${prefix}${crypto.randomUUID()}`);
  await recordProgress(engine, page, caller);
  const status =
    page.status.type === "snapshotting"
      ? `{"type":"snapshotting"}`
      : `{"type":${JSON.stringify(page.status.type)},"snapshotTs":${BigInt(page.status.snapshotTs) * 1000n}}`;
  const values = page.values.map(
    (v) =>
      `{"component":"","table":${JSON.stringify(v.table)},"ts":${BigInt(v.ts) * 1000n},"deleted":${v.deleted},"value":${v.json}}`,
  );
  return `{"status":${status},"truncates":[${page.truncates.map((t) => `{"component":"","table":${JSON.stringify(t)}}`).join(",")}],"values":[${values.join(",")}],"syncId":${JSON.stringify(page.cursor.syncId)},"pagination":{"hasMore":true,"nextCursor":${JSON.stringify(sealCursor(engine, page.cursor))}}}`;
}

/** `POST /api/data_sync_cursor_from_deltas` `{cursor: ns, selection?}`: a sync that continues a document_deltas one. */
export async function cursorFromDeltas(engine: Engine, req: Request): Promise<string> {
  const text = await req.text();
  const exact = text.replace(/"cursor"\s*:\s*(-?\d+)/g, '"cursor":"$1"');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(exact) as Record<string, unknown>;
  } catch (e) {
    throw bad("BadJsonBody", (e as Error).message);
  }
  const prefix = clientPrefix(req);
  const raw = body.cursor;
  if (typeof raw !== "string" || !/^\d+$/.test(raw))
    throw bad("InvalidDataSyncCursor", "The document_deltas cursor is not a valid timestamp");
  const ts = Number(BigInt(raw) / 1000n);
  const targets = dataSyncTargets(engine, selectionArg(body.selection));
  if (ts > engine.committer.visibleTs)
    throw bad("InvalidDataSyncCursor", "document_deltas cursor is ahead of the deployment's latest timestamp");
  if (ts + 1 < (engine.retention?.minDocumentTs ?? 0)) throw expired();
  const cursor: DataSyncCursor = {
    syncedTs: ts,
    synced: targets.map((x) => ref(x.t)),
    current: null,
    syncId: `${prefix}${crypto.randomUUID()}`,
    numDocsSynced: 0,
  };
  return `{"cursor":${JSON.stringify(sealCursor(engine, cursor))}}`;
}

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  let b: unknown;
  try {
    const text = await req.text();
    b = text.trim() === "" ? {} : JSON.parse(text);
  } catch (e) {
    throw bad("BadJsonBody", (e as Error).message);
  }
  if (b === null || typeof b !== "object" || Array.isArray(b)) throw bad("BadJsonBody", "expected an object");
  return b as Record<string, unknown>;
}

function selectionArg(raw: unknown): Selection {
  return raw === undefined ? { _other: "included" } : selectionOf({ selection: raw });
}

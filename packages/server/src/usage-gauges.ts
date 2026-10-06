// Storage usage gauges (STUDY-73), as Convex's `UsageGaugesTrackingWorker`
// (crates/usage_gauges_tracking_worker): every USAGE_TRACKING_PERIOD_SECS (1 h), splayed to between half and
// one and a half of it, the deployment's storage totals go to the log streams as a `current_storage_usage`
// event, once the table summaries are built. Its usage events go nowhere in Convex's open-source backend;
// the file storage total it keeps limits exports that include storage (1 TiB).
import { type Engine, FILE_STORAGE_TABLE, isReservedIndex, SYSTEM_TO_VIRTUAL_TABLE } from "@bunvex/core";
import type { LogEvent, StorageUsage } from "./log-events.ts";

/** The deployment's storage, as Convex's `get_gauge_metrics` and `compute_totals` sum it. */
export async function storageUsage(engine: Engine): Promise<StorageUsage> {
  let documentBytes = 0;
  let indexBytes = 0;
  let vectorBytes = 0;
  let textBytes = 0;
  const system = { _storage: 0, _scheduled_functions: 0 };
  for (const t of engine.catalog.tables.values()) {
    const size = engine.tableSummaries.get(t.id).size;
    // A virtual table's documents are its system tables' (Convex's `virtual_tables` usage): `_storage` is
    // `_file_storage`, `_scheduled_functions` is `_scheduled_jobs` and `_scheduled_job_args`.
    const virtual = SYSTEM_TO_VIRTUAL_TABLE[t.name] as keyof typeof system | undefined;
    if (virtual !== undefined) system[virtual] += size;
    if (t.name.startsWith("_")) continue;
    documentBytes += size;
    // Convex's approximation: each enabled (or backfilled staged) index of a user table costs the table's
    // documents again; `by_id` and `by_creation_time` are not charged.
    for (const ix of t.indexes.values()) if (!isReservedIndex(ix)) indexBytes += size;
    // Vector indexes: their vectors × dimensions × 4 (`estimate_pricing_size_bytes`); text indexes: their
    // indexed bytes, for Convex's segments (DV-317).
    for (const e of engine.vectorIndexes.forTablet(t.id)) vectorBytes += e.index.size * e.def.dimensions * 4;
    for (const e of engine.searchIndexes.forTablet(t.id)) textBytes += e.index.indexedBytes;
  }
  return {
    documentBytes,
    indexBytes,
    vectorBytes,
    textBytes,
    fileBytes: await fileStorageBytes(engine),
    // Convex's cloud backups; a self-hosted deployment has none.
    backupBytes: 0,
    systemTableDocumentBytes: system,
  };
}

/** Every stored file's size (Convex's `FileStorageSizeTracker`), at one snapshot, page by page. */
async function fileStorageBytes(engine: Engine): Promise<number> {
  if (!engine.catalog.tables.has(FILE_STORAGE_TABLE)) return 0;
  let total = 0;
  let cursor: string | null = null;
  for (;;) {
    const page = (await engine.query((db) =>
      db.asSystem(() => db.query(FILE_STORAGE_TABLE).paginate({ numItems: 1000, cursor })),
    )) as { page: { size?: unknown }[]; isDone: boolean; continueCursor: string };
    for (const f of page.page) if (typeof f.size === "bigint") total += Number(f.size);
    if (page.isDone) return total;
    cursor = page.continueCursor;
  }
}

export type UsageGaugeOptions = {
  /** USAGE_TRACKING_PERIOD_SECS, in ms. Default 1 h. */
  periodMs?: number;
  random?: () => number;
};

/** The worker: a run, then the next after the splayed period, until stopped. */
export class UsageGauges {
  /** The file storage total of the last run (Convex's `latest_file_storage_size`), null before one. */
  latestFileStorageBytes: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly periodMs: number;
  private readonly random: () => number;

  constructor(
    private engine: Engine,
    private send: (events: LogEvent[]) => void,
    opts: UsageGaugeOptions = {},
  ) {
    this.periodMs = opts.periodMs ?? Number(process.env.USAGE_TRACKING_PERIOD_SECS ?? 3600) * 1000;
    this.random = opts.random ?? Math.random;
  }

  start() {
    this.schedule();
  }

  private schedule() {
    if (this.stopped) return;
    // Convex splays first, on start too: half the period plus up to a whole one.
    const wait = this.periodMs / 2 + this.periodMs * this.random();
    this.timer = setTimeout(() => {
      this.run()
        .catch((e) => console.error(`bunvex: storage usage gauges failed: ${(e as Error).message}`))
        .finally(() => this.schedule());
    }, wait);
  }

  /** One run: the totals to the log streams, unless the table summaries are not built yet. */
  async run(): Promise<StorageUsage | null> {
    if (!this.engine.tableSummaries.ready) return null;
    const usage = await storageUsage(this.engine);
    this.latestFileStorageBytes = usage.fileBytes;
    this.send([{ timestamp: Date.now(), event: { topic: "current_storage_usage", ...usage } }]);
    return usage;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

// The contract suite's part for snapshots (UI-01 §19.2, data-source-snapshot.ts). Reading the latest export
// is checked whenever offered; requesting an export and importing only when the caller opts in — an export
// loads the server, and an import writes (to a scratch table the caller names).
import { expect } from "bun:test";
import type { DashboardDataSource, SnapshotExport, SnapshotImport } from "./data-source.ts";

export type SnapshotContractOptions = {
  snapshots?: {
    /** Request an export, wait for it, and download it. */
    export?: boolean;
    /** Import into this scratch table (it ends with the imported documents only). */
    import?: { table: string };
    /** How long to wait for an export or an import to finish. Default 20 000 ms. */
    timeoutMs?: number;
  };
};

type Ctx = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
  opts: SnapshotContractOptions;
};

const STATES = ["requested", "in_progress", "completed", "failed"];

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function describeSnapshotContract({ make, test, opts }: Ctx) {
  const timeoutMs = opts.snapshots?.timeoutMs ?? 20_000;

  test("latest snapshot export (when offered): none, or one with a known state", async () => {
    const src = await make();
    if (!src.getLatestSnapshotExport) return;
    if (!(await src.getCapabilities()).operations.includes("viewBackups")) return;
    const e = await src.getLatestSnapshotExport();
    if (e === null) return;
    expect(typeof e.id).toBe("string");
    expect(STATES).toContain(e.state);
  });

  if (opts.snapshots?.export)
    test("snapshot export (opt-in): requested, then completed, then a zip to download", async () => {
      const src = await make();
      if (!src.requestSnapshotExport || !src.getLatestSnapshotExport || !src.downloadSnapshotExport) return;
      const asked = await src.requestSnapshotExport({ includeStorage: false });
      expect(["requested", "in_progress"]).toContain(asked.state);
      const done = await until<SnapshotExport | null>(
        () => src.getLatestSnapshotExport!(),
        (e) => e?.state === "completed" || e?.state === "failed",
        timeoutMs,
      );
      expect(done?.id).toBe(asked.id);
      expect(done?.state).toBe("completed");
      const zip = new Uint8Array(await (await src.downloadSnapshotExport(asked.id)).arrayBuffer());
      expect(zip.length).toBe(done!.size!);
      expect(String.fromCharCode(zip[0]!, zip[1]!)).toBe("PK");
    });

  const scratch = opts.snapshots?.import?.table;
  if (scratch)
    test("snapshot import (opt-in): parsed, confirmed, then written; a bad file fails with why", async () => {
      const src = await make();
      if (!src.startSnapshotImport || !src.confirmSnapshotImport || !src.getSnapshotImport) return;
      const bad = await src.startSnapshotImport({
        file: new Blob(["{oops"]),
        format: "jsonLines",
        mode: "replace",
        table: scratch,
      });
      expect(bad.state).toBe("failed");
      expect(bad.error).toBeTruthy();
      const file = new Blob(['{"n":1,"s":"a"}\n{"n":2,"s":"b"}\n'], { type: "application/jsonl" });
      const started = await src.startSnapshotImport({ file, format: "jsonLines", mode: "replace", table: scratch });
      expect(started.state).toBe("waiting_for_confirmation");
      expect(started.changes?.find((c) => c.table === scratch)?.add).toBe(2);
      await src.confirmSnapshotImport(started.id);
      const done = await until<SnapshotImport>(
        () => src.getSnapshotImport!(started.id),
        (i) => i.state === "completed" || i.state === "failed",
        timeoutMs,
      );
      expect(done.state).toBe("completed");
      expect(done.rowsWritten).toBe(2);
      const page = await src.listDocuments({ table: scratch, numItems: 10, cursor: null });
      expect(page.page.map((d) => d.n).sort()).toEqual([1, 2]);
    });
}

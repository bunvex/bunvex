// Snapshots — exporting the deployment's data and importing it back (UI-01 §19.2, STUDY-12 §13.2). A bunvex
// addition: Convex's self-hosted dashboard has neither (its cloud has snapshot export; importing is
// `npx convex import`). The shapes follow Convex's where they exist: an export is requested, runs, then is
// downloaded as a zip (`/api/export/request/zip`, `latestExport`); an import is uploaded, parsed, waits for
// confirmation with a summary of what changes, then runs (`snapshot_import`, its states and modes). Every
// method is optional; a source offers each half by having its methods (detected with `typeof`).
// Re-exported by `data-source.ts`.
import type { CallOptions } from "./data-source.ts";

export type SnapshotExportState = "requested" | "in_progress" | "completed" | "failed";

export type SnapshotExport = {
  id: string;
  state: SnapshotExportState;
  /** Wall-clock ms. */
  requestedAt: number;
  /** With the stored files (`_storage/…` in the zip), or tables only. */
  includeStorage: boolean;
  /** While in progress: what it is doing, in words. */
  progress?: string;
  /** Once completed: when, how large the zip is, and until when it can be downloaded. */
  completedAt?: number;
  size?: number;
  expiresAt?: number;
  /** Once failed: why. */
  error?: string;
};

/** As `npx convex import --format`: a zip snapshot, or one table as JSON Lines, a JSON array or CSV. */
export type SnapshotImportFormat = "zip" | "jsonLines" | "jsonArray" | "csv";

/**
 * As `npx convex import`: `requireEmpty` (the default) refuses a table that has documents; `append` adds to
 * them; `replace` empties the imported tables first; `replaceAll` (a zip) also empties every other table.
 */
export type SnapshotImportMode = "requireEmpty" | "append" | "replace" | "replaceAll";

export type SnapshotImportRequest = {
  file: Blob;
  format: SnapshotImportFormat;
  mode: SnapshotImportMode;
  /** Required for every format but `zip`, where the tables come from the file. */
  table?: string;
};

export type SnapshotImportState = "uploaded" | "waiting_for_confirmation" | "in_progress" | "completed" | "failed";

export type SnapshotImport = {
  id: string;
  state: SnapshotImportState;
  format: SnapshotImportFormat;
  mode: SnapshotImportMode;
  /** Waiting for confirmation: what will change, per table. */
  changes?: { table: string; add: number; delete: number }[];
  /** In progress: what it is doing; and the steps already done. */
  progress?: string;
  checkpoints?: string[];
  /** Completed: how many documents were written. */
  rowsWritten?: number;
  /** Failed: why. */
  error?: string;
};

export interface SnapshotFeatures {
  /** The latest export, or null when there has been none. Needs `viewBackups`. */
  getLatestSnapshotExport?(opts?: CallOptions): Promise<SnapshotExport | null>;
  /** Starts an export; it replaces the latest one. Needs `createBackups`. */
  requestSnapshotExport?(options: { includeStorage: boolean }, opts?: CallOptions): Promise<SnapshotExport>;
  /** The completed export's zip. Needs `downloadBackups`. Fails for an export that is not completed or expired. */
  downloadSnapshotExport?(id: string, opts?: CallOptions): Promise<Blob>;
  /**
   * Uploads and parses a file. A file that cannot be imported comes back `failed` (with why); one that can
   * waits for confirmation with its `changes`. Needs `importBackups` and a credential that may write.
   */
  startSnapshotImport?(request: SnapshotImportRequest, opts?: CallOptions): Promise<SnapshotImport>;
  confirmSnapshotImport?(id: string, opts?: CallOptions): Promise<void>;
  /** Drops an import that waits for confirmation. */
  cancelSnapshotImport?(id: string, opts?: CallOptions): Promise<void>;
  getSnapshotImport?(id: string, opts?: CallOptions): Promise<SnapshotImport>;
}

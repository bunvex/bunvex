// The Settings screens over a deployment (STUDY-149 PR 4), as Convex's dashboard reads them (STUDY-149 §1.2):
// the environment variables with `listEnvironmentVariables`, kept subscribed while someone watches, and changed
// with `/api/update_environment_variables`; the authentication providers with `listAuthProviders`; the snapshot
// export with `latestExport` and `/api/export/*`, the imports with `/api/import/*`, `/api/perform_import` and
// `/api/cancel_import` (Convex's cloud dashboard; bunvex's Settings has them, decided in STUDY-149 Q6); the
// deployment's URLs with `cloudUrl` and `siteUrl` (Convex's `convexCloudUrl` and `convexSiteUrl`, DV-474).
import {
  type AuthProvider,
  type CallOptions,
  DataSourceError,
  type EnvironmentVariable,
  type EnvironmentVariableChange,
  type SnapshotExport,
  type SnapshotImport,
  type SnapshotImportFormat,
  type SnapshotImportMode,
  type SnapshotImportRequest,
  type Unsubscribe,
} from "@bunvex/dashboard/data-source";
import { fromJsonValue, type JSONValue } from "@bunvex/values";
import type { AdminHttp } from "./admin-http.ts";
import { LiveGroup } from "./live.ts";
import type { AdminSync } from "./sync.ts";
import { msOfNs, numberOf } from "./wire.ts";

/** The size of each part an import's file is uploaded in (Convex's CLI uploads 8 MiB parts). */
export const IMPORT_PART_BYTES = 8 * 1024 * 1024;

type ExportDoc = {
  _id: string;
  _creationTime: number;
  state: "requested" | "in_progress" | "completed" | "failed" | "canceled";
  format: { format: string; include_storage?: boolean };
  start_ts?: bigint;
  complete_ts?: bigint;
  expiration_ts?: bigint;
  progress_message?: string;
  size?: bigint;
};

type ImportDoc = {
  _id: string;
  _creationTime: number;
  state:
    | { state: "uploaded" }
    | { state: "waiting_for_confirmation"; message_to_confirm: string; require_manual_confirmation: boolean }
    | { state: "in_progress"; progress_message: string; checkpoint_messages: string[] }
    | { state: "completed"; timestamp: bigint; num_rows_written: bigint }
    | { state: "failed"; error_message: string };
  format: { format: string; table?: string };
  mode: string;
  checkpoints:
    | { display_table_name: string; total_num_rows_to_write: bigint; existing_rows_to_delete: bigint }[]
    | null;
};

/** An `_exports` document as the contract shows it (times in ms). */
export function exportOf(d: ExportDoc): SnapshotExport {
  return {
    id: d._id,
    state: d.state,
    requestedAt: d.start_ts !== undefined ? msOfNs(d.start_ts) : Math.round(d._creationTime),
    includeStorage: d.format.include_storage ?? false,
    ...(d.progress_message !== undefined && d.state === "in_progress" && { progress: d.progress_message }),
    ...(d.complete_ts !== undefined && { completedAt: msOfNs(d.complete_ts) }),
    ...(d.size !== undefined && { size: numberOf(d.size) }),
    ...(d.expiration_ts !== undefined && { expiresAt: msOfNs(d.expiration_ts) }),
  };
}

/** Convex's import formats (`ImportFormat`, as stored) → the contract's. */
const FORMATS: Record<string, SnapshotImportFormat> = {
  zip: "zip",
  csv: "csv",
  json_array: "jsonArray",
  jsonl: "jsonLines",
};
/** Convex's import modes (as stored) → the contract's. */
const MODES: Record<string, SnapshotImportMode> = {
  RequireEmpty: "requireEmpty",
  Append: "append",
  Replace: "replace",
  ReplaceAll: "replaceAll",
};

/** A `_snapshot_imports` document as the contract shows it: the changes per table come from its checkpoints. */
export function importOf(d: ImportDoc): SnapshotImport {
  const s = d.state;
  const base = { id: d._id, format: FORMATS[d.format.format] ?? "zip", mode: MODES[d.mode] ?? "requireEmpty" };
  switch (s.state) {
    case "uploaded":
      return { ...base, state: "uploaded" };
    case "waiting_for_confirmation":
      return {
        ...base,
        state: "waiting_for_confirmation",
        changes: (d.checkpoints ?? []).map((c) => ({
          table: c.display_table_name,
          add: numberOf(c.total_num_rows_to_write),
          delete: numberOf(c.existing_rows_to_delete),
        })),
      };
    case "in_progress":
      return { ...base, state: "in_progress", progress: s.progress_message, checkpoints: s.checkpoint_messages };
    case "completed":
      return { ...base, state: "completed", rowsWritten: numberOf(s.num_rows_written) };
    case "failed":
      return { ...base, state: "failed", error: s.error_message };
  }
}

/** A stored provider (`_auth`) as the contract shows it: the system fields dropped, the algorithm unquoted. */
export function authProviderOf(d: Record<string, unknown>): AuthProvider {
  if (d.type === "customJwt") {
    const alg = String(d.algorithm);
    return {
      type: "customJwt",
      issuer: String(d.issuer),
      jwks: String(d.jwks),
      // stored as its JSON string (Convex's `String::from(SignatureAlgorithm)`)
      algorithm: (alg.startsWith('"') ? JSON.parse(alg) : alg) as "RS256" | "ES256",
      ...(typeof d.applicationID === "string" && { applicationID: d.applicationID }),
    };
  }
  return { domain: String(d.domain), applicationID: String(d.applicationID) };
}

/** The import's format as the HTTP API names it (`ImportFormatArg`). */
const FORMAT_ARGS: Record<SnapshotImportFormat, string> = {
  zip: "zip",
  csv: "csv",
  jsonArray: "jsonArray",
  jsonLines: "jsonLines",
};

export class Settings {
  private readonly group: LiveGroup;

  constructor(
    private readonly sync: AdminSync,
    private readonly http: AdminHttp,
  ) {
    this.group = new LiveGroup(sync);
  }

  // ---------------------------------------------------------------- environment variables

  async listEnvironmentVariables(o?: CallOptions): Promise<EnvironmentVariable[]> {
    const docs = await this.group.read<{ name: string; value: string }[]>(
      "_system/frontend/listEnvironmentVariables",
      {},
      { list: "env", first: true, pausable: false, signal: o?.signal },
    );
    return docs.map((d) => ({ name: d.name, value: d.value }));
  }

  /** Convex's `useUpdateEnvVars`: the batch as it is; the server checks it whole (a 400 names the variable). */
  async updateEnvironmentVariables(changes: EnvironmentVariableChange[], o?: CallOptions): Promise<void> {
    await this.http.request("/api/update_environment_variables", { body: { changes }, signal: o?.signal });
  }

  watchEnvironmentVariables(onChange: () => void, onError: (e: DataSourceError) => void): Unsubscribe {
    const off = this.group.watch(() => onChange(), onError);
    // followed once read: read it, so a watcher that comes first hears the next change
    this.listEnvironmentVariables().catch((e: unknown) =>
      onError(e instanceof DataSourceError ? e : new DataSourceError("unavailable", String(e))),
    );
    return off;
  }

  // ---------------------------------------------------------------- authentication

  async listAuthProviders(o?: CallOptions): Promise<AuthProvider[]> {
    const docs = await this.sync.query<Record<string, unknown>[]>("_system/frontend/listAuthProviders", {}, o?.signal);
    return docs.map(authProviderOf);
  }

  // ---------------------------------------------------------------- the deployment's URLs

  /** `BUNVEX_CLOUD_URL` and `BUNVEX_SITE_URL` (null when unset, or when the credential cannot view data). */
  async urls(o?: CallOptions): Promise<{ cloud: string | null; site: string | null }> {
    const read = (path: string) =>
      this.sync.query<string | null>(path, {}, o?.signal).catch((e: unknown) => {
        if (e instanceof DataSourceError && e.code === "unauthorized") return null;
        throw e;
      });
    const [cloud, site] = await Promise.all([read("_system/frontend/cloudUrl"), read("_system/frontend/siteUrl")]);
    return { cloud, site };
  }

  // ---------------------------------------------------------------- snapshots

  /**
   * A system query over `/api/query`, read fresh: an export or an import moves on its own, and a socket result the
   * client keeps for a query just dropped could be older than the request that started it.
   */
  private async fresh<T>(path: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const body = await this.http.json<{ status: string; value?: JSONValue; errorMessage?: string }>("/api/query", {
      body: { path, args, format: "encoded_json" },
      signal,
    });
    if (body.status !== "success") {
      const message = body.errorMessage ?? `${path} failed`;
      throw new DataSourceError(/permission/i.test(message) ? "unauthorized" : "unavailable", message);
    }
    // in the client's values, as a subscription's (int64 as bigint)
    return fromJsonValue(body.value ?? null) as T;
  }

  async getLatestSnapshotExport(o?: CallOptions): Promise<SnapshotExport | null> {
    const d = await this.fresh<ExportDoc | null>("_system/frontend/latestExport", {}, o?.signal);
    return d && exportOf(d);
  }

  /** `POST /api/export/request/zip`, which answers nothing: the export is then the latest one. */
  async requestSnapshotExport(options: { includeStorage: boolean }, o?: CallOptions): Promise<SnapshotExport> {
    await this.http.request(`/api/export/request/zip?includeStorage=${options.includeStorage}`, {
      method: "POST",
      signal: o?.signal,
    });
    const latest = await this.getLatestSnapshotExport(o);
    if (!latest) throw new DataSourceError("unavailable", "The export was requested but is not listed.");
    return latest;
  }

  async downloadSnapshotExport(id: string, o?: CallOptions): Promise<Blob> {
    const res = await this.http.request(`/api/export/zip/${encodeURIComponent(id)}`, { signal: o?.signal });
    return res.blob();
  }

  /**
   * As `bunvex import`: the file uploaded in parts (`start_upload`, `upload_part`, `finish_upload`), then read
   * until the deployment has parsed it — waiting for confirmation, with what changes, or failed, with why.
   */
  async startSnapshotImport(request: SnapshotImportRequest, o?: CallOptions): Promise<SnapshotImport> {
    const { uploadToken } = await this.http.json<{ uploadToken: string }>("/api/import/start_upload", {
      method: "POST",
      signal: o?.signal,
    });
    const partTokens: string[] = [];
    const size = request.file.size;
    for (let at = 0, part = 1; at < size || part === 1; at += IMPORT_PART_BYTES, part++) {
      partTokens.push(
        await this.http.json<string>(
          `/api/import/upload_part?uploadToken=${encodeURIComponent(uploadToken)}&partNumber=${part}`,
          { bytes: request.file.slice(at, at + IMPORT_PART_BYTES), signal: o?.signal },
        ),
      );
    }
    const { importId } = await this.http.json<{ importId: string }>("/api/import/finish_upload", {
      body: {
        import: {
          format: FORMAT_ARGS[request.format],
          mode: request.mode,
          ...(request.table !== undefined && { tableName: request.table }),
        },
        uploadToken,
        partTokens,
      },
      signal: o?.signal,
    });
    for (;;) {
      const i = await this.getSnapshotImport(importId, o);
      if (i.state !== "uploaded") return i;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async confirmSnapshotImport(id: string, o?: CallOptions): Promise<void> {
    await this.http.request("/api/perform_import", { body: { importId: id }, signal: o?.signal });
  }

  async cancelSnapshotImport(id: string, o?: CallOptions): Promise<void> {
    await this.http.request("/api/cancel_import", { body: { importId: id }, signal: o?.signal });
  }

  async getSnapshotImport(id: string, o?: CallOptions): Promise<SnapshotImport> {
    const d = await this.fresh<ImportDoc | null>("_system/cli/queryImport", { importId: id }, o?.signal);
    if (!d) throw new DataSourceError("not_found", `No import ${id}.`);
    return importOf(d);
  }

  close(): void {
    this.group.close();
  }
}

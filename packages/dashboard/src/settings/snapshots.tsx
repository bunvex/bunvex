// Settings → Snapshots (UI-01 §19.2, STUDY-12 §13.2): exporting the deployment's data as a zip, and importing
// a snapshot or a table's file back. A bunvex addition — Convex's self-hosted dashboard has neither (its cloud
// has snapshot export; importing is `npx convex import`) — built on their shapes: an export is requested, runs,
// then is downloaded; an import is uploaded and parsed, shows what will change, and runs once confirmed, with
// `npx convex import`'s formats and modes.
import { Button } from "@bunvex/ui/components/button";
import { Checkbox } from "@bunvex/ui/components/checkbox";
import { ChoiceRadios } from "@bunvex/ui/components/choice-radios";
import { FilePicker } from "@bunvex/ui/components/file-picker";
import { Input } from "@bunvex/ui/components/input";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, dashboardKeys, type QueryScope } from "../data/queries.ts";
import {
  type SnapshotExport,
  type SnapshotImport,
  type SnapshotImportFormat,
  type SnapshotImportMode,
  toDataSourceError,
} from "../data-source.ts";
import { formatBytes, formatCount } from "../screens/stats.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { NotOffered } from "../shell/not-offered.tsx";
import { SettingsLayout } from "./layout.tsx";

const RUNNING = new Set(["requested", "in_progress", "uploaded"]);
const POLL_MS = 500;

export const latestExportQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: [...dashboardKeys.all(scope), "snapshot-export"] as const,
    queryFn: ({ signal }) => source.getLatestSnapshotExport!({ signal }),
    // while it runs, look again; once it settles, stop
    refetchInterval: (q) => (q.state.data && RUNNING.has(q.state.data.state) ? POLL_MS : false),
  });

const when = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
const docs = (n: number) => `${formatCount(n)} document${n === 1 ? "" : "s"}`;

export function SnapshotsSettingsScreen() {
  const { source } = useQueryScope();
  const canExport = typeof source.getLatestSnapshotExport === "function";
  const canImport = typeof source.startSnapshotImport === "function";
  if (!canExport && !canImport) return <NotOffered title="Settings" what="snapshots" />;
  return (
    <SettingsLayout title="Snapshots" description="Export this deployment's data, or import some">
      <div className="flex max-w-3xl flex-col gap-10">
        {canExport && <ExportSection />}
        {canImport && <ImportSection />}
      </div>
    </SettingsLayout>
  );
}

// ------------------------------------------------------------------ export

function ExportSection() {
  const scope = useQueryScope();
  const { source } = scope;
  const queryClient = useQueryClient();
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const ops = caps?.operations ?? [];
  const canView = ops.includes("viewBackups");
  const canRequest = ops.includes("createBackups") && typeof source.requestSnapshotExport === "function";
  const canDownload = ops.includes("downloadBackups") && typeof source.downloadSnapshotExport === "function";
  const latest = useQuery({ ...latestExportQuery(scope), enabled: caps !== undefined && canView });
  const [includeStorage, setIncludeStorage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const storageId = useId();
  const running = !!latest.data && RUNNING.has(latest.data.state);

  const request = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const e = await source.requestSnapshotExport!({ includeStorage });
      queryClient.setQueryData(latestExportQuery(scope).queryKey, e);
    } catch (err) {
      setProblem(toDataSourceError(err).message);
    }
    setBusy(false);
  };

  const download = async (e: SnapshotExport) => {
    setProblem(undefined);
    try {
      const blob = await source.downloadSnapshotExport!(e.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `snapshot-${new Date(e.completedAt ?? e.requestedAt).toISOString().slice(0, 19).replaceAll(":", "-")}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setProblem(toDataSourceError(err).message);
    }
  };

  return (
    <section aria-labelledby="snapshot-export">
      <h2 id="snapshot-export" className="text-base font-medium">
        Export
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A zip with every table's documents (one folder per table, JSON Lines), and the stored files if you ask.
      </p>
      {caps !== undefined && !canView ? (
        <p className="mt-3 text-sm text-muted-foreground">This credential cannot view snapshots.</p>
      ) : (
        <>
          {canRequest && (
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <span className="flex items-center gap-2">
                <Checkbox
                  id={storageId}
                  checked={includeStorage}
                  onCheckedChange={(on) => setIncludeStorage(on === true)}
                  disabled={running || busy}
                />
                <label htmlFor={storageId} className="text-sm">
                  Include stored files
                </label>
              </span>
              <Button onClick={() => void request()} disabled={running || busy}>
                Export a snapshot
              </Button>
            </div>
          )}
          <div aria-live="polite" className="mt-4 text-sm">
            {latest.isPending ? null : latest.error ? (
              <ErrorState error={toDataSourceError(latest.error)} onRetry={() => void latest.refetch()} />
            ) : !latest.data ? (
              <p className="text-muted-foreground">No snapshot has been exported yet.</p>
            ) : (
              <ExportStatus e={latest.data} onDownload={canDownload ? () => void download(latest.data!) : undefined} />
            )}
          </div>
        </>
      )}
      {problem && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {problem}
        </p>
      )}
    </section>
  );
}

function ExportStatus({ e, onDownload }: { e: SnapshotExport; onDownload?: () => void }) {
  const what = e.includeStorage ? "tables and stored files" : "tables";
  if (e.state === "failed")
    return (
      <p className="text-destructive">
        The export requested {when(e.requestedAt)} failed: {e.error}
      </p>
    );
  if (e.state !== "completed")
    return (
      <p>
        Exporting {what}… <span className="text-muted-foreground">{e.progress ?? "Waiting to start"}</span>
      </p>
    );
  const expired = e.expiresAt !== undefined && Date.now() > e.expiresAt;
  return (
    <div className="flex flex-wrap items-center gap-3 border p-3">
      <div className="min-w-0 flex-1">
        <p>
          Snapshot of {what}, {e.completedAt !== undefined && when(e.completedAt)}
          {e.size !== undefined && <span className="text-muted-foreground"> · {formatBytes(e.size)}</span>}
        </p>
        {e.expiresAt !== undefined && (
          <p className="text-xs text-muted-foreground">
            {expired
              ? `Expired ${when(e.expiresAt)}: export a new one.`
              : `Can be downloaded until ${when(e.expiresAt)}.`}
          </p>
        )}
      </div>
      {onDownload && !expired && (
        <Button variant="outline" onClick={onDownload}>
          <Download aria-hidden="true" />
          Download
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ import

const FORMATS: { value: SnapshotImportFormat; label: string; ext: RegExp }[] = [
  { value: "zip", label: "Snapshot (.zip)", ext: /\.zip$/i },
  { value: "jsonLines", label: "JSON Lines (.jsonl)", ext: /\.jsonl$/i },
  { value: "jsonArray", label: "JSON array (.json)", ext: /\.json$/i },
  { value: "csv", label: "CSV (.csv)", ext: /\.csv$/i },
];

const MODES: { value: SnapshotImportMode; label: string; zipOnly?: boolean }[] = [
  { value: "requireEmpty", label: "Only into empty tables" },
  { value: "append", label: "Add to the documents already there" },
  { value: "replace", label: "Replace the documents of the imported tables" },
  { value: "replaceAll", label: "Replace everything: tables not in the snapshot are emptied", zipOnly: true },
];

function ImportSection() {
  const scope = useQueryScope();
  const { source } = scope;
  const queryClient = useQueryClient();
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const allowed =
    caps === undefined ||
    (caps.operations.includes("importBackups") && caps.operations.includes("writeData") && !caps.readOnly);
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<SnapshotImportFormat>("zip");
  const [mode, setMode] = useState<SnapshotImportMode>("requireEmpty");
  const [table, setTable] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [started, setStarted] = useState<SnapshotImport | null>(null);
  const fileId = useId();
  const tableId = useId();
  const confirmed = started && started.state !== "waiting_for_confirmation";
  const status = useQuery({
    queryKey: [...dashboardKeys.all(scope.scope), "snapshot-import", started?.id ?? null],
    queryFn: ({ signal }) => source.getSnapshotImport!(started!.id, { signal }),
    enabled: !!confirmed && typeof source.getSnapshotImport === "function",
    refetchInterval: (q) =>
      q.state.data && (q.state.data.state === "completed" || q.state.data.state === "failed") ? false : POLL_MS,
  });
  const current = (confirmed && status.data) || started;
  const finished = status.data?.state === "completed";
  useEffect(() => {
    // the tables changed: what the dashboard has loaded about them reloads
    if (finished) void queryClient.invalidateQueries({ queryKey: dashboardKeys.all(scope.scope) });
  }, [finished, queryClient, scope.scope]);

  if (caps !== undefined && !allowed)
    return (
      <section aria-labelledby="snapshot-import">
        <h2 id="snapshot-import" className="text-base font-medium">
          Import
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This credential cannot import: it needs to import snapshots and write data.
        </p>
      </section>
    );

  const pick = (f: File | null) => {
    setFile(f);
    setProblem(undefined);
    const guess = f && FORMATS.find((x) => x.ext.test(f.name));
    if (guess) {
      setFormat(guess.value);
      if (guess.value !== "zip" && !table) setTable(f.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_"));
    }
    if (guess && guess.value !== "zip" && mode === "replaceAll") setMode("requireEmpty");
  };

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setProblem(undefined);
    try {
      setStarted(await source.startSnapshotImport!({ file, format, mode, ...(format !== "zip" && { table }) }));
    } catch (err) {
      setProblem(toDataSourceError(err).message);
    }
    setBusy(false);
  };

  const act = async (what: "confirm" | "cancel") => {
    if (!started) return;
    setBusy(true);
    setProblem(undefined);
    try {
      if (what === "confirm") {
        await source.confirmSnapshotImport!(started.id);
        setStarted({ ...started, state: "in_progress" });
      } else {
        await source.cancelSnapshotImport!(started.id);
        setStarted(null);
      }
    } catch (err) {
      setProblem(toDataSourceError(err).message);
    }
    setBusy(false);
  };

  const reset = () => {
    setStarted(null);
    setFile(null);
    setProblem(undefined);
  };

  const deleting = (current?.changes ?? []).reduce((n, c) => n + c.delete, 0);
  const formReady = !!file && (format === "zip" || table.trim() !== "");

  return (
    <section aria-labelledby="snapshot-import">
      <h2 id="snapshot-import" className="text-base font-medium">
        Import
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A snapshot (.zip) restores its tables; a JSON Lines, JSON or CSV file goes into one table. Nothing changes until
        you confirm what the import will do.
      </p>
      {!started ? (
        <form
          className="mt-3 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void upload();
          }}
        >
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">File</span>
            <FilePicker
              id={fileId}
              label="File"
              accept=".zip,.jsonl,.json,.csv"
              file={file}
              onFile={pick}
              hint="A .zip snapshot, or one table as .jsonl, .json or .csv — or drop it here"
            />
          </div>
          <ChoiceRadios
            label="Format"
            value={format}
            options={FORMATS}
            onValueChange={(f) => {
              setFormat(f);
              if (f !== "zip" && mode === "replaceAll") setMode("requireEmpty");
            }}
          />
          {format !== "zip" && (
            <div className="flex flex-col gap-1">
              <label htmlFor={tableId} className="text-sm font-medium">
                Into the table
              </label>
              <Input
                id={tableId}
                className="max-w-xs font-mono"
                value={table}
                onChange={(e) => setTable(e.target.value)}
              />
            </div>
          )}
          <ChoiceRadios
            label="When a table already has documents"
            value={mode}
            options={MODES.filter((m) => !m.zipOnly || format === "zip")}
            onValueChange={setMode}
          />
          <div>
            <Button type="submit" disabled={!formReady || busy}>
              {busy ? "Reading the file…" : "Upload and review"}
            </Button>
          </div>
        </form>
      ) : (
        <div aria-live="polite" className="mt-3 flex flex-col gap-3 text-sm">
          <ImportStatus imp={current!} />
          {current!.state === "waiting_for_confirmation" && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant={deleting > 0 ? "destructive" : "default"}
                disabled={busy}
                onClick={() => void act("confirm")}
              >
                {deleting > 0 ? `Import and delete ${docs(deleting)}` : "Import"}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void act("cancel")}>
                Cancel
              </Button>
            </div>
          )}
          {(current!.state === "completed" || current!.state === "failed") && (
            <div>
              <Button variant="outline" onClick={reset}>
                Import another file
              </Button>
            </div>
          )}
        </div>
      )}
      {problem && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {problem}
        </p>
      )}
    </section>
  );
}

function ImportStatus({ imp }: { imp: SnapshotImport }) {
  if (imp.state === "failed")
    return (
      <p role="alert" className="text-destructive">
        The import failed: {imp.error}
      </p>
    );
  if (imp.state === "completed")
    return (
      <div>
        <p>Imported {docs(imp.rowsWritten ?? 0)}.</p>
        <Checkpoints items={imp.checkpoints} />
      </div>
    );
  if (imp.state === "waiting_for_confirmation")
    return (
      <div>
        <p>This import will change:</p>
        <table className="mt-2 w-full max-w-md text-left text-sm">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th scope="col" className="py-1 font-normal">
                Table
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                Added
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                Deleted
              </th>
            </tr>
          </thead>
          <tbody>
            {(imp.changes ?? []).map((c) => (
              <tr key={c.table} className="border-b last:border-b-0">
                <th scope="row" className="py-1 font-mono text-xs font-normal">
                  {c.table}
                </th>
                <td className="py-1 text-right tabular-nums">{formatCount(c.add)}</td>
                <td className={`py-1 text-right tabular-nums ${c.delete > 0 ? "text-destructive" : ""}`}>
                  {formatCount(c.delete)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <div>
      <p>
        Importing… <span className="text-muted-foreground">{imp.progress ?? "Starting"}</span>
      </p>
      <Checkpoints items={imp.checkpoints} />
    </div>
  );
}

function Checkpoints({ items }: { items?: string[] }) {
  if (!items?.length) return null;
  return (
    <ul className="mt-1 list-disc pl-5 text-muted-foreground">
      {items.map((c) => (
        <li key={c}>{c}</li>
      ))}
    </ul>
  );
}

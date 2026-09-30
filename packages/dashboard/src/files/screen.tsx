// The Files screen (UI-01 §14.3, STUDY-12 §9): the deployment's stored files, newest first (or oldest),
// between two dates, with a lookup by storage id; upload, select and delete; a file's details beside the
// list — a preview for images, as Convex, its metadata, Download and Delete.
import { Button, buttonVariants } from "@bunvex/ui/components/button";
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { Input } from "@bunvex/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@bunvex/ui/components/select";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery } from "../data/queries.ts";
import { type StoredFile, toDataSourceError } from "../data-source.ts";
import { formatTime } from "../database/values.ts";
import { type FilesSearch, filesRoute } from "../router.tsx";
import { formatBytes, formatCount } from "../screens/stats.ts";
import { ConfirmButton } from "../shell/confirm.tsx";
import { DayInput, dayBound } from "../shell/day-input.tsx";
import { ErrorState } from "../shell/error-state.tsx";
import { NotOffered } from "../shell/not-offered.tsx";
import { Panel } from "../shell/panel.tsx";
import { fileCountQuery, fileKeys, fileQuery, filesQuery, useFilesLive } from "./queries.ts";

const col = dataTableColumns<StoredFile>();

export { formatBytes }; // shared (screens/stats.ts); tests import it from here

const files = (n: number) => `${formatCount(n)} ${n === 1 ? "file" : "files"}`;

export function FilesScreen() {
  const { source } = useQueryScope();
  if (typeof source.listFiles !== "function") return <NotOffered title="Files" what="file storage" />;
  return <Files />;
}

function Files() {
  const scope = useQueryScope();
  const { source } = scope;
  const queryClient = useQueryClient();
  const search = filesRoute.useSearch();
  const navigate = filesRoute.useNavigate();
  const setSearch = (patch: Partial<FilesSearch>, replace = false) =>
    navigate({ search: (s: FilesSearch): FilesSearch => ({ ...s, ...patch }), replace });
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const canWrite = caps !== undefined && !caps.readOnly && caps.operations.includes("writeData");
  const filter = { order: search.order ?? "desc", from: dayBound(search.from, false), to: dayBound(search.to, true) };
  const list = useInfiniteQuery(filesQuery(scope, filter));
  const { data: count } = useQuery(fileCountQuery(scope));
  const liveError = useFilesLive();
  const rows = list.data?.pages.flatMap((p) => p.page) ?? [];
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const selectedIds = useMemo(() => rows.filter((f) => selected.has(f.id)).map((f) => f.id), [rows, selected]);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string }>();
  const [uploading, setUploading] = useState<number>();
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: fileKeys.all(scope.scope) });
  const lookupId = useId();
  const orderId = useId();
  const [lookup, setLookup] = useState("");

  const upload = async (picked: File[]) => {
    if (picked.length === 0) return;
    setUploading(picked.length);
    setOutcome(undefined);
    try {
      for (const f of picked) await source.uploadFile!(f);
      setOutcome({ ok: true, message: `Uploaded ${files(picked.length)}.` });
    } catch (e) {
      setOutcome({ ok: false, message: `Could not upload: ${toDataSourceError(e).message}` });
    }
    setUploading(undefined);
    await refresh();
  };

  const remove = async (ids: string[]) => {
    await source.deleteFiles!(ids);
    setSelected(new Set());
    setOutcome({ ok: true, message: `Deleted ${files(ids.length)}.` });
    if (search.file !== undefined && ids.includes(search.file)) setSearch({ file: undefined }, true);
    await refresh();
  };

  const columns: DataTableColumn<StoredFile>[] = [
    col.accessor((f) => f.id, {
      id: "id",
      header: "Storage ID",
      cell: (c) => <span className="truncate font-mono text-xs">{c.getValue()}</span>,
    }),
    col.accessor((f) => f.size, {
      id: "size",
      header: "Size",
      cell: (c) => <span className="text-xs tabular-nums">{formatBytes(c.getValue())}</span>,
    }),
    col.accessor((f) => f.contentType, {
      id: "type",
      header: "Content type",
      cell: (c) => <span className="font-mono text-xs">{c.getValue() ?? "unknown"}</span>,
    }),
    col.accessor((f) => f.creationTime, {
      id: "uploaded",
      header: "Uploaded",
      cell: (c) => <span className="font-mono text-xs tabular-nums">{formatTime(c.getValue())}</span>,
    }),
  ];

  return (
    // full-bleed inside <main>: the details panel runs to its edges
    <div className="-m-4 flex min-h-[calc(100svh-3rem)] md:-m-6">
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 md:p-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight">Files</h1>
          {count !== undefined && <span className="text-sm text-muted-foreground">{files(count)} stored</span>}
          <span className="ml-auto flex items-center gap-2">
            {canWrite && selectedIds.length > 0 && typeof source.deleteFiles === "function" && (
              <ConfirmButton
                label={`Delete ${formatCount(selectedIds.length)}`}
                variant="destructive"
                title={`Delete ${files(selectedIds.length)}?`}
                description="They are removed from storage, and their URLs stop working. This cannot be undone."
                confirm={`Delete ${files(selectedIds.length)}`}
                busy="Deleting…"
                keep="Keep them"
                action={() => remove(selectedIds)}
              />
            )}
            {typeof source.uploadFile === "function" && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  aria-label="Files to upload"
                  onChange={(e) => {
                    void upload([...(e.target.files ?? [])]);
                    e.target.value = "";
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canWrite || uploading !== undefined}
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload aria-hidden="true" />
                  {uploading !== undefined ? `Uploading ${files(uploading)}…` : "Upload files"}
                </Button>
              </>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (lookup.trim()) setSearch({ file: lookup.trim() });
            }}
          >
            <label className="flex flex-col gap-1 text-sm text-muted-foreground" htmlFor={lookupId}>
              Look up by storage ID
              <Input
                id={lookupId}
                className="h-8 w-72 font-mono text-xs"
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
              />
            </label>
            <Button type="submit" size="sm" variant="outline">
              Open
            </Button>
          </form>
          <div className="flex flex-col gap-1">
            <span id={orderId} className="text-sm text-muted-foreground">
              Order
            </span>
            <Select
              items={[
                { value: "desc", label: "Newest first" },
                { value: "asc", label: "Oldest first" },
              ]}
              value={search.order ?? "desc"}
              onValueChange={(v) => setSearch({ order: v === "asc" ? "asc" : undefined })}
            >
              <SelectTrigger aria-labelledby={orderId} className="h-8 min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desc">Newest first</SelectItem>
                <SelectItem value="asc">Oldest first</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {(["from", "to"] as const).map((side) => (
            <DayInput
              key={side}
              label={side === "from" ? "Uploaded from" : "Uploaded until"}
              value={search[side]}
              onChange={(v) => setSearch({ [side]: v }, true)}
            />
          ))}
        </div>
        <p role={outcome && !outcome.ok ? "alert" : "status"} className="min-h-5 text-sm">
          <span className={outcome?.ok === false ? "text-destructive" : "text-muted-foreground"}>
            {outcome?.message}
          </span>
        </p>
        {liveError && <ErrorState error={liveError} />}
        {list.error ? (
          <ErrorState error={toDataSourceError(list.error)} />
        ) : (
          <DataTable
            label="Files"
            className="max-h-[calc(100svh-18rem)]"
            columns={columns}
            data={rows}
            getRowId={(f) => f.id}
            defaultColumnWidth={(id) => ({ id: 300, size: 100, type: 200, uploaded: 190 })[id] ?? 160}
            onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && void list.fetchNextPage()}
            selection={
              canWrite && typeof source.deleteFiles === "function" ? { selected, onChange: setSelected } : undefined
            }
            grid={{ activateOnClick: true, onCellActivate: (f) => setSearch({ file: f.id }) }}
            empty={
              list.isPending
                ? "Loading…"
                : search.from || search.to
                  ? "No file was uploaded in these dates."
                  : "No files yet. Upload one here, or store one from a function with ctx.storage."
            }
            footer={<span aria-live="polite">{`${files(rows.length)}${list.hasNextPage ? " loaded" : ""}`}</span>}
          />
        )}
      </div>
      {search.file !== undefined && (
        <FileDetails
          id={search.file}
          canDelete={canWrite && typeof source.deleteFiles === "function"}
          onDelete={() => remove([search.file!])}
          onClose={() => setSearch({ file: undefined })}
        />
      )}
    </div>
  );
}

function FileDetails(props: { id: string; canDelete: boolean; onDelete: () => Promise<void>; onClose: () => void }) {
  const scope = useQueryScope();
  const { data: file, error, isPending } = useQuery(fileQuery(scope, props.id));
  return (
    <Panel title="File" onClose={props.onClose}>
      {error ? (
        <ErrorState error={toDataSourceError(error)} />
      ) : isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !file ? (
        <p className="text-sm text-muted-foreground">
          There is no file <code className="font-mono text-xs">{props.id}</code>: it was deleted, or the ID is wrong.
        </p>
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          {file.contentType?.startsWith("image/") && (
            <figure className="flex justify-center border bg-muted/40 p-2">
              <img src={file.url} alt={`Preview of ${file.id}`} className="max-h-64 max-w-full object-contain" />
            </figure>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">Storage ID</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <code className="truncate font-mono text-xs">{file.id}</code>
              <CopyButton text={file.id} label="Copy ID" size="xs" />
            </dd>
            <dt className="text-muted-foreground">Size</dt>
            <dd>
              {formatBytes(file.size)} <span className="text-muted-foreground">({formatCount(file.size)} bytes)</span>
            </dd>
            <dt className="text-muted-foreground">Content type</dt>
            <dd className="font-mono text-xs">{file.contentType ?? "unknown"}</dd>
            <dt className="text-muted-foreground">SHA-256</dt>
            <dd className="font-mono text-xs break-all">{file.sha256}</dd>
            <dt className="text-muted-foreground">Uploaded</dt>
            <dd>
              <time dateTime={new Date(file.creationTime).toISOString()}>{formatTime(file.creationTime)}</time>
            </dd>
          </dl>
          <div className="flex gap-2">
            <a href={file.url} download={file.id} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Download
            </a>
            <ConfirmButton
              label="Delete"
              variant="destructive"
              disabled={!props.canDelete}
              title="Delete this file?"
              description="It is removed from storage, and its URL stops working. This cannot be undone."
              confirm="Delete the file"
              busy="Deleting…"
              keep="Keep it"
              action={props.onDelete}
            />
          </div>
        </div>
      )}
    </Panel>
  );
}

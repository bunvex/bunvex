// The Files screen's section column (UI-01 §24): Upload on top; the storage used (files, bytes, a bar by
// kind); the views by kind (All files, Images, Documents, Other); the filters — upload date and size — each
// choice with how many files it holds (the source's `fileStats`, counted under the other sections'
// choices); and the buckets, only "Default" for now (a bunvex placeholder, STUDY-12 §7.7).
import { useQueries, useQuery } from "@tanstack/react-query";
import { Files, FileText, Image, Package } from "lucide-react";
import type { ReactNode } from "react";
import { useQueryScope } from "../context.tsx";
import type { FileFilter, FileKind } from "../data-source.ts";
import { DashLink, type FilesSearch } from "../router.tsx";
import { formatBytes, formatCount } from "../screens/stats.ts";
import { dayBound } from "../shell/day-input.tsx";
import { FacetRadios, SECTION_ITEM, SectionFilters, SectionNav } from "../shell/section-column.tsx";
import { fileStatsQuery } from "./queries.ts";

export const VIEWS = [
  { value: "images", kind: "image", label: "Images", icon: Image },
  { value: "documents", kind: "document", label: "Documents", icon: FileText },
  { value: "other", kind: "other", label: "Other", icon: Package },
] as const satisfies readonly { value: FilesSearch["view"]; kind: FileKind; label: string; icon: unknown }[];

export const SIZES = [
  { value: "small", label: "Under 1 KB", range: { maxSize: 1023 } },
  { value: "medium", label: "1 KB – 1 MB", range: { minSize: 1024, maxSize: 1024 * 1024 - 1 } },
  { value: "large", label: "Over 1 MB", range: { minSize: 1024 * 1024 } },
] as const;

const DAYS = [
  { value: "all", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const;
type DayPreset = (typeof DAYS)[number]["value"];

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A preset's first day (the viewer's zone); none for "Any time". */
export function presetFrom(p: DayPreset, today = new Date()): string | undefined {
  if (p === "all") return undefined;
  const back = p === "today" ? 0 : p === "7d" ? 6 : 29;
  return isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back));
}
const presetOf = (from?: string, to?: string) =>
  to ? undefined : DAYS.find((d) => presetFrom(d.value) === from)?.value;

/** The filter a search stands for, in the source's terms. */
export function filterOf(search: FilesSearch): FileFilter {
  return {
    from: dayBound(search.from, false),
    to: dayBound(search.to, true),
    kind: VIEWS.find((v) => v.value === search.view)?.kind,
    ...SIZES.find((s) => s.value === search.size)?.range,
  };
}

const KIND_FILL: Record<FileKind, string> = {
  image: "bg-chart-1",
  document: "bg-chart-2",
  other: "bg-chart-3",
};

/** Files and bytes stored, and a bar of the bytes by kind (with a legend in words). */
function Usage() {
  const scope = useQueryScope();
  const { data: s } = useQuery(fileStatsQuery(scope, {}));
  if (!s) return null;
  const kinds = VIEWS.map((v) => ({ ...v, bytes: s.byKind[v.kind].bytes }));
  return (
    <section aria-label="Storage used" className="border-b px-3 py-3">
      <p className="text-sm">
        <span className="font-medium tabular-nums">{formatBytes(s.totalBytes)}</span>{" "}
        <span className="text-muted-foreground">
          in {formatCount(s.count)} {s.count === 1 ? "file" : "files"}
        </span>
      </p>
      {s.totalBytes > 0 && (
        <div className="mt-2 flex h-2 gap-[2px] overflow-hidden" aria-hidden="true">
          {kinds
            .filter((k) => k.bytes > 0)
            .map((k) => (
              <div
                key={k.value}
                className={KIND_FILL[k.kind]}
                style={{ width: `${(k.bytes / s.totalBytes) * 100}%` }}
              />
            ))}
        </div>
      )}
      <ul className="mt-2 flex flex-col gap-0.5 text-xs">
        {kinds.map((k) => (
          <li key={k.value} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`size-2 shrink-0 ${KIND_FILL[k.kind]}`} />
            <span className="flex-1">{k.label}</span>
            <span className="text-muted-foreground tabular-nums">{formatBytes(k.bytes)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const Count = ({ n }: { n?: number }) =>
  n === undefined ? null : <span className="text-xs text-muted-foreground tabular-nums">{formatCount(n)}</span>;

export function FilesSections(props: {
  search: FilesSearch;
  /** Merges into the search; `replace` for the address only. */
  setSearch: (patch: Partial<FilesSearch>) => void;
}) {
  const scope = useQueryScope();
  const { search, setSearch } = props;
  const f = filterOf(search);
  const byKind = useQuery(fileStatsQuery(scope, { ...f, kind: undefined })).data;
  const days = useQueries({
    queries: DAYS.map((d) =>
      fileStatsQuery(scope, { ...f, from: dayBound(presetFrom(d.value), false), to: undefined }),
    ),
  });
  const sizes = useQueries({
    queries: [{ value: "all" as const, range: {} }, ...SIZES].map((s) =>
      fileStatsQuery(scope, { ...f, minSize: undefined, maxSize: undefined, ...s.range }),
    ),
  });
  const link = (view: FilesSearch["view"], label: string, icon: ReactNode, n?: number) => (
    <li key={view ?? "all"}>
      <DashLink
        link={{
          to: "/files",
          // the open file stays when its view is picked again; another view closes it
          search: search.view === view ? search : { ...search, view, file: undefined },
          // the view is in the search: only the current one is the current page
          activeOptions: { exact: true, includeSearch: true },
        }}
        className={SECTION_ITEM}
      >
        {icon}
        <span className="flex-1">{label}</span>
        <Count n={n} />
      </DashLink>
    </li>
  );
  const icon = "size-4 shrink-0 text-muted-foreground";
  const filtered = search.from !== undefined || search.to !== undefined || search.size !== undefined;
  return (
    <>
      <Usage />
      <SectionNav
        label="File views"
        groups={[
          {
            label: "Views",
            items: (
              <>
                {link(undefined, "All files", <Files className={icon} aria-hidden="true" />, byKind?.count)}
                {VIEWS.map((v) =>
                  link(v.value, v.label, <v.icon className={icon} aria-hidden="true" />, byKind?.byKind[v.kind].count),
                )}
              </>
            ),
          },
        ]}
      />
      <SectionFilters
        label="File filters"
        onReset={filtered ? () => setSearch({ from: undefined, to: undefined, size: undefined }) : undefined}
      >
        <FacetRadios
          title="Uploaded"
          options={DAYS.map((d, i) => ({ value: d.value, label: d.label, count: days[i]?.data?.count }))}
          value={presetOf(search.from, search.to)}
          onChange={(p) => setSearch({ from: presetFrom(p), to: undefined })}
          note={
            search.from && !presetOf(search.from, search.to)
              ? "A custom range, set in the bar above the list."
              : undefined
          }
        />
        <FacetRadios
          title="Size"
          options={[{ value: "all", label: "Any size" }, ...SIZES].map((s, i) => ({
            value: s.value,
            label: s.label,
            count: sizes[i]?.data?.count,
          }))}
          value={search.size ?? "all"}
          onChange={(v) => setSearch({ size: v === "all" ? undefined : (v as FilesSearch["size"]) })}
        />
      </SectionFilters>
      <SectionNav
        label="Buckets"
        groups={[
          {
            label: "Buckets",
            items: (
              <li>
                <span aria-current="true" className={`${SECTION_ITEM} border-foreground bg-muted font-medium`}>
                  <Package className={icon} aria-hidden="true" />
                  <span className="flex-1">Default</span>
                </span>
              </li>
            ),
          },
        ]}
      />
    </>
  );
}

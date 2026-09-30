// The table list beside the Database screen: search, one link per table with its size, a marker on
// tables the schema does not declare, and "Create table" where the credential can write. Its right edge resizes it (the width is kept in this browser). Below
// the md breakpoint it is a picker above the table instead.
import { Input } from "@bunvex/ui/components/input";
import { ResizeHandle } from "@bunvex/ui/components/resize-handle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@bunvex/ui/components/select";
import { Table2 } from "lucide-react";
import { useId, useState } from "react";
import type { TableInfo } from "../data-source.ts";
import { DashLink, tableRoute } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";
import { CreateTable } from "./create-table.tsx";

const ITEM =
  "flex h-8 items-center gap-2 border-l-2 border-transparent px-3 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=page]:border-foreground aria-[current=page]:bg-muted aria-[current=page]:font-medium";

const WIDTH_KEY = "bunvex-dashboard:tables-width";
const DEFAULT = 224;
const MIN = 160;
const MAX = 480;

/** The table list's width, kept in this browser; `undefined` puts the default back. */
function useWidth(): [number, (w: number | undefined) => void] {
  const [width, setState] = useState(() => {
    try {
      const w = Number(localStorage.getItem(WIDTH_KEY));
      return w >= MIN && w <= MAX ? w : DEFAULT;
    } catch {
      return DEFAULT;
    }
  });
  const set = (w: number | undefined) => {
    setState(w ?? DEFAULT);
    try {
      if (w === undefined) localStorage.removeItem(WIDTH_KEY);
      else localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      // for this page only
    }
  };
  return [width, set];
}

export function TablesSidebar(props: { tables: TableInfo[]; current: string; canCreate: boolean }) {
  const { tables, current } = props;
  const [query, setQuery] = useState("");
  const [width, setWidth] = useWidth();
  const [dragging, setDragging] = useState<number>();
  const searchId = useId();
  const pickerLabel = useId();
  const navigate = tableRoute.useNavigate();
  const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  const shown = sorted.filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <>
      <div className="flex items-center gap-2 border-b px-4 py-2 lg:hidden">
        <span id={pickerLabel} className="text-sm text-muted-foreground">
          Table
        </span>
        <Select
          items={sorted.map((t) => ({ value: t.name, label: t.name }))}
          value={current}
          onValueChange={(v) => navigate({ to: "/database/$table", params: { table: v as string } })}
        >
          <SelectTrigger aria-labelledby={pickerLabel} className="min-w-40 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sorted.map((t) => (
              <SelectItem key={t.name} value={t.name}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <nav
        aria-label="Tables"
        className="relative hidden shrink-0 flex-col border-r lg:flex"
        style={{ width: dragging ?? width }}
      >
        <h2 className="sr-only">Tables</h2>
        <div className="p-3">
          <label htmlFor={searchId} className="sr-only">
            Search tables
          </label>
          <Input
            id={searchId}
            type="search"
            placeholder="Search tables"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <ul className="flex-1 overflow-y-auto pb-3">
          {shown.map((t) => (
            <li key={t.name}>
              <DashLink link={{ to: "/database/$table", params: { table: t.name } }} className={ITEM}>
                <Table2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">
                  {t.name}
                  {!t.declared && (
                    <span className="ml-1 text-muted-foreground" title="Not in the schema">
                      *<span className="sr-only"> (not in the schema)</span>
                    </span>
                  )}
                </span>
                {t.documentCount !== undefined && (
                  <span className="text-xs text-muted-foreground tabular-nums">{formatCount(t.documentCount)}</span>
                )}
              </DashLink>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">No table matches “{query}”.</li>
          )}
        </ul>
        {props.canCreate && (
          <div className="border-t p-2">
            <CreateTable tables={tables.map((t) => t.name)} />
          </div>
        )}
        <ResizeHandle
          label="Resize the table list"
          value={dragging ?? width}
          min={MIN}
          max={MAX}
          onDrag={setDragging}
          onCommit={(w) => {
            setDragging(undefined);
            setWidth(w);
          }}
        />
      </nav>
    </>
  );
}

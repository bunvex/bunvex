// A read-only data table for long lists: TanStack Table v9 for the model, TanStack Virtual for the rows, so
// ten thousand documents cost the DOM of a screenful. It stays a real <table> (header cells, row and
// column semantics); the rows not rendered are announced through aria-rowcount / aria-rowindex. Scrolling
// near the end calls `onEndReached`, which is how a paginated source loads its next page.
import { cn } from "@bunvex/ui/lib/utils";
import { type ColumnDef, createColumnHelper, type RowData, tableFeatures, useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useEffect, useId, useRef } from "react";

/** The table features every DataTable has. Columns are typed against it (`dataTableColumns`). */
export const dataTableFeatures = tableFeatures({});
export type DataTableFeatures = typeof dataTableFeatures;
// biome-ignore lint/suspicious/noExplicitAny: each column has its own value type; a list of them cannot name one
export type DataTableColumn<TData extends RowData> = ColumnDef<DataTableFeatures, TData, any>;

/** A column helper for DataTable columns: `const col = dataTableColumns<Doc>(); col.accessor("_id", …)`. */
export const dataTableColumns = <TData extends RowData>() => createColumnHelper<DataTableFeatures, TData>();

type DataTableProps<TData extends RowData> = {
  /** The accessible name of the table. */
  label: string;
  columns: DataTableColumn<TData>[];
  data: TData[];
  /** A stable id per row (e.g. a document's `_id`); default: the index. */
  getRowId?: (row: TData, index: number) => string;
  /** Fixed row height in px; the virtualizer relies on it. Default 36. */
  rowHeight?: number;
  /** Called when the last rendered row is within `endThreshold` rows of the end. */
  onEndReached?: () => void;
  endThreshold?: number;
  /** A row the user activates (click, or Enter on the focused row). */
  onRowActivate?: (row: TData) => void;
  /** Shown in place of the rows when `data` is empty. */
  empty?: ReactNode;
  /** Shown below the last row, e.g. "Loading more…". */
  footer?: ReactNode;
  /** Height used before the scroll container is measured (and in environments without layout). */
  initialHeight?: number;
  className?: string;
};

function DataTable<TData extends RowData>({
  label,
  columns,
  data,
  getRowId,
  rowHeight = 36,
  onEndReached,
  endThreshold = 10,
  onRowActivate,
  empty,
  footer,
  initialHeight = 600,
  className,
}: DataTableProps<TData>) {
  const table = useTable({ features: dataTableFeatures, columns, data, getRowId }, () => null);
  const rows = table.getRowModel().rows;
  const scroller = useRef<HTMLElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    initialRect: { width: 0, height: initialHeight },
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.at(-1)?.index ?? -1;

  const onEnd = useRef(onEndReached);
  onEnd.current = onEndReached;
  useEffect(() => {
    if (rows.length > 0 && lastIndex >= rows.length - 1 - endThreshold) onEnd.current?.();
  }, [lastIndex, rows.length, endThreshold]);

  const before = items[0]?.start ?? 0;
  const after = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);
  const columnCount = table.getAllLeafColumns().length;
  const captionId = useId();

  return (
    <section
      ref={scroller}
      data-slot="data-table"
      className={cn("relative max-h-[70vh] overflow-auto border", className)}
      aria-labelledby={captionId}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable to scroll it with the keyboard (WCAG 2.1.1, axe scrollable-region-focusable)
      tabIndex={0}
    >
      <table className="w-full border-collapse text-sm" aria-rowcount={rows.length + 1}>
        <caption id={captionId} className="sr-only">
          {label}
        </caption>
        <thead className="sticky top-0 z-10 bg-muted text-left">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} aria-rowindex={1}>
              {group.headers.map((header) => (
                <th key={header.id} scope="col" className="h-9 border-b px-3 font-medium whitespace-nowrap">
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columnCount} className="px-3 py-8 text-center text-muted-foreground">
                {empty ?? "Nothing here."}
              </td>
            </tr>
          ) : (
            <>
              {before > 0 && (
                // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a spacer row is not focusable; hiding it keeps it out of the row count
                <tr aria-hidden="true" style={{ height: before }} />
              )}
              {items.map((item) => {
                const row = rows[item.index]!;
                return (
                  <tr
                    key={row.id}
                    aria-rowindex={item.index + 2}
                    style={{ height: rowHeight }}
                    className={cn(
                      "border-b last:border-b-0",
                      onRowActivate &&
                        "cursor-pointer outline-none hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    )}
                    tabIndex={onRowActivate ? 0 : undefined}
                    onClick={onRowActivate && (() => onRowActivate(row.original))}
                    onKeyDown={
                      onRowActivate &&
                      ((e) => {
                        if (e.key === "Enter") onRowActivate(row.original);
                      })
                    }
                  >
                    {row.getAllCells().map((cell) => (
                      <td key={cell.id} className="max-w-96 truncate px-3 whitespace-nowrap">
                        <table.FlexRender cell={cell} />
                      </td>
                    ))}
                  </tr>
                );
              })}
              {after > 0 && (
                // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a spacer row is not focusable; hiding it keeps it out of the row count
                <tr aria-hidden="true" style={{ height: after }} />
              )}
            </>
          )}
        </tbody>
      </table>
      {footer && <div className="border-t px-3 py-2 text-sm text-muted-foreground">{footer}</div>}
    </section>
  );
}

export { DataTable };

// A data table for long lists: TanStack Table v9 for the model, TanStack Virtual for the rows, so ten
// thousand documents cost the DOM of a screenful. The rows not rendered are announced through
// aria-rowcount / aria-rowindex. Scrolling near the end calls `onEndReached`, which is how a paginated
// source loads its next page.
//
// With `grid`, it is an ARIA data grid (WAI-ARIA APG "Data Grid"): one cell is in the tab order; arrows,
// Home/End, Ctrl+Home/End and PageUp/PageDown move between cells, scrolling the virtual list along; Enter
// (or a double-click) edits a cell through the caller's editor, or activates a cell that cannot be edited.
// The focused cell is remembered by its row's id, so it stays on the same row when rows arrive above it.
// A cell's context menu (`grid.cellMenu`) opens on a right-click, Shift+F10, the Menu key or Ctrl/Cmd+Enter;
// the caller can add its own shortcuts on a cell (`grid.onCellKey`).

import { Checkbox } from "@bunvex/ui/components/checkbox";
import { DropdownMenu, DropdownMenuContent } from "@bunvex/ui/components/dropdown-menu";
import { ResizeHandle } from "@bunvex/ui/components/resize-handle";
import { cellKey, diffSnapshots, type Snapshot, snapshotOf } from "@bunvex/ui/lib/change-tracking";
import { type ColumnState, clampWidth, MAX_WIDTH, MIN_WIDTH, mergeColumnOrder } from "@bunvex/ui/lib/column-state";
import { cn } from "@bunvex/ui/lib/utils";
import { type ColumnDef, createColumnHelper, type RowData, tableFeatures, useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** The table features every DataTable has. Columns are typed against it (`dataTableColumns`). */
export const dataTableFeatures = tableFeatures({});
export type DataTableFeatures = typeof dataTableFeatures;
// biome-ignore lint/suspicious/noExplicitAny: each column has its own value type; a list of them cannot name one
export type DataTableColumn<TData extends RowData> = ColumnDef<DataTableFeatures, TData, any>;

/** A column helper for DataTable columns: `const col = dataTableColumns<Doc>(); col.accessor("_id", …)`. */
export const dataTableColumns = <TData extends RowData>() => createColumnHelper<DataTableFeatures, TData>();

/** Rows the user picked with the checkbox column, by row id. Controlled. */
export type SelectionOptions<TData> = {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** How a row is named to screen readers ("Select row …"). Default: its id. */
  describe?: (row: TData) => string;
};

/** The id of the checkbox column `selection` adds in front. */
export const SELECT_COLUMN = "__select";

export type HighlightOptions = {
  /** How long a change stays marked. Default 1 500 ms (the length of the flash). */
  durationMs?: number;
  /** A sentence for screen readers about a batch of changes; at most one every 5 s. Omit: no announcement. */
  announce?: (batch: { changed: number; added: number }) => string;
};

/** How an edit ended: stay on the cell, move to the next one, or nothing changed. */
export type EditOutcome = "stay" | "right" | "cancel";

export type DataGridOptions<TData> = {
  /** Whether Enter or a double-click edits this cell. */
  canEdit?: (row: TData, columnId: string) => boolean;
  /** Shown in place of the cell while it is edited; call `done` when the edit ends (saved or not). */
  renderEditor?: (edit: { row: TData; columnId: string; done: (outcome: EditOutcome) => void }) => ReactNode;
  /** Enter on a cell that cannot be edited (e.g. open the row's details). */
  onCellActivate?: (row: TData, columnId: string) => void;
  /** A click on a cell that cannot be edited activates it too, not only a double-click (a list of lines). */
  activateOnClick?: boolean;
  /** The current cell moved to another row or column (arrows, a click) — e.g. an open details panel follows. */
  onCellFocus?: (row: TData, columnId: string) => void;
  /**
   * The items of a cell's context menu (DropdownMenu items). `edit` starts editing the cell (when it can
   * be edited). Without it, there is no context menu.
   */
  cellMenu?: (cell: { row: TData; columnId: string; edit: () => void }) => ReactNode;
  /** A key on a cell (not in an editor), before the grid's own keys; return true when it was handled. */
  onCellKey?: (e: KeyboardEvent<HTMLElement>, cell: { row: TData; columnId: string }) => boolean;
};

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
  /** A row the user activates (click, or Enter on the focused row). Not with `grid`. */
  onRowActivate?: (row: TData) => void;
  /** Cell-by-cell keyboard navigation and editing. */
  grid?: DataGridOptions<TData>;
  /**
   * A checkbox column in front: click, or Space / Enter on its cell, toggles a row; with Shift, every row
   * since the last one toggled; the header's checkbox selects or clears every loaded row. Needs `getRowId`.
   */
  selection?: SelectionOptions<TData>;
  /**
   * Change it to put the focus on the grid's current cell — e.g. after a dialog whose opener went away
   * (the Delete button leaves with the selection) closes. Not on the first render.
   */
  focusRequest?: unknown;
  /**
   * The columns' order, hidden ones and widths (UI-01 §12.5.6). With `onColumnStateChange`, each header gets
   * a resize handle — drag it, or focus it and use the arrow keys; a double-click resets the width — and the
   * caller persists the new state.
   */
  columnState?: ColumnState;
  onColumnStateChange?: (state: ColumnState) => void;
  /** px, for a column without a saved width: a number, or one per column id. Default 180. */
  defaultColumnWidth?: number | ((columnId: string) => number);
  /** Shown in place of the rows when `data` is empty. */
  empty?: ReactNode;
  /** Shown below the last row, e.g. "Loading more…". */
  footer?: ReactNode;
  /** When it changes, the list scrolls back to the top (a new sort or filter is a new list). */
  resetKey?: unknown;
  /**
   * Keep the row at the top of the view in place when rows are added or removed above it (a live list).
   * Needs `getRowId`. Default true.
   */
  anchorTopRow?: boolean;
  /**
   * Mark what changed while the list is shown (a live list): a cell whose value changed, a row that arrived
   * between rows already shown, and — when you have scrolled — rows arriving above the view. Compared by
   * row id; needs `getRowId`. A new `resetKey` starts the comparison over.
   */
  highlightChanges?: boolean | HighlightOptions;
  /** Height used before the scroll container is measured (and in environments without layout). */
  initialHeight?: number;
  className?: string;
};

const HEADER_HEIGHT = 36;

/** A column definition's id: its `id`, or the key it reads. */
const idOf = (c: { id?: string; accessorKey?: unknown }) => c.id ?? String(c.accessorKey);

function DataTable<TData extends RowData>({
  label,
  columns,
  data,
  getRowId,
  rowHeight = 36,
  onEndReached,
  endThreshold = 10,
  onRowActivate,
  grid,
  empty,
  footer,
  initialHeight = 600,
  resetKey,
  anchorTopRow = true,
  highlightChanges,
  selection,
  focusRequest,
  columnState,
  onColumnStateChange,
  defaultColumnWidth = 180,
  className,
}: DataTableProps<TData>) {
  // ---------------------------------------------------------------- selection: the checkbox column

  const anchor = useRef<string | null>(null);
  const shift = useRef(false);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const rowsRef = useRef<{ id: string; original: TData }[]>([]);
  /** Toggles one row, or with `range` every row from the last one toggled, to the row's new state. */
  const toggle = useCallback((id: string, range: boolean) => {
    const sel = selectionRef.current;
    if (!sel) return;
    const next = new Set(sel.selected);
    const on = !next.has(id);
    const ids = rowsRef.current.map((r) => r.id);
    const from = range && anchor.current !== null ? ids.indexOf(anchor.current) : -1;
    const to = ids.indexOf(id);
    const span = from >= 0 && to >= 0 ? ids.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
    for (const x of span) on ? next.add(x) : next.delete(x);
    anchor.current = id;
    sel.onChange(next);
  }, []); // reads refs only: stable
  // ---------------------------------------------------------------- columns: order, visibility, widths

  const order = columnState?.order;
  const hidden = columnState?.hidden;
  const shown = useMemo(() => {
    const byId = new Map(columns.map((c) => [idOf(c), c]));
    const off = new Set(hidden ?? []);
    return mergeColumnOrder(order ?? [], [...byId.keys()])
      .filter((id) => !off.has(id))
      .map((id) => byId.get(id)!);
  }, [columns, order, hidden]);
  const [dragging, setDragging] = useState<{ id: string; width: number } | null>(null);
  const widthOf = (id: string) =>
    id === SELECT_COLUMN
      ? 40
      : dragging?.id === id
        ? dragging.width
        : (columnState?.widths?.[id] ??
          (typeof defaultColumnWidth === "function" ? defaultColumnWidth(id) : defaultColumnWidth));
  const setWidth = (id: string, width: number | undefined) => {
    const widths = { ...columnState?.widths };
    if (width === undefined) delete widths[id];
    else widths[id] = clampWidth(width);
    onColumnStateChange?.({ ...columnState, widths });
  };

  const selectable = selection !== undefined;
  const withSelect = useMemo<DataTableColumn<TData>[]>(() => {
    if (!selectable) return shown;
    const helper = createColumnHelper<DataTableFeatures, TData>();
    const select = helper.display({
      id: SELECT_COLUMN,
      header: () => {
        const sel = selectionRef.current!;
        const ids = rowsRef.current.map((r) => r.id);
        const count = ids.filter((id) => sel.selected.has(id)).length;
        const all = count > 0 && count === ids.length;
        return (
          <Checkbox
            aria-label="Select every loaded row"
            tabIndex={-1}
            checked={all}
            indeterminate={count > 0 && !all}
            onCheckedChange={() => sel.onChange(all ? new Set() : new Set(ids))}
          />
        );
      },
      cell: (c) => {
        const sel = selectionRef.current!;
        const id = c.row.id;
        return (
          <span
            className="flex items-center"
            onClickCapture={(e) => {
              shift.current = e.shiftKey;
            }}
          >
            <Checkbox
              aria-label={`Select row ${sel.describe?.(c.row.original) ?? id}`}
              tabIndex={-1}
              checked={sel.selected.has(id)}
              onCheckedChange={() => toggle(id, shift.current)}
            />
          </span>
        );
      },
    });
    return [select, ...shown];
    // the checkbox cells read the selection through a ref: the column set changes only with `columns`
  }, [shown, selectable, toggle]);

  const table = useTable({ features: dataTableFeatures, columns: withSelect, data, getRowId }, () => null);
  const rows = table.getRowModel().rows;
  rowsRef.current = rows;
  const columnIds = table.getAllLeafColumns().map((c) => c.id);
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

  // ---------------------------------------------------------------- live lists: keep the top row

  // ---------------------------------------------------------------- live lists: what changed

  const highlight = highlightChanges === true ? {} : highlightChanges || null;
  const duration = highlight?.durationMs ?? 1500;
  const [flash, setFlash] = useState<{ cells: Set<string>; rows: Set<string>; above: boolean }>(() => ({
    cells: new Set(),
    rows: new Set(),
    above: false,
  }));
  const snapshot = useRef<{ key: unknown; rows: Snapshot } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const pending = useRef<{ changed: number; added: number; last: number; timer?: ReturnType<typeof setTimeout> }>({
    changed: 0,
    added: 0,
    last: 0,
  });
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const all = timers.current;
    const p = pending.current;
    return () => {
      for (const t of all) clearTimeout(t);
      clearTimeout(p.timer);
    };
  }, []);
  const later = (ms: number, f: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      f();
    }, ms);
    timers.current.add(t);
  };

  const announce = (changed: number, added: number) => {
    const describe = highlight?.announce;
    if (!describe) return;
    const p = pending.current;
    p.changed += changed;
    p.added += added;
    const say = () => {
      p.last = Date.now();
      setAnnouncement(describe({ changed: p.changed, added: p.added }));
      p.changed = 0;
      p.added = 0;
    };
    const wait = p.last + 5000 - Date.now();
    clearTimeout(p.timer);
    if (wait <= 0) say();
    else p.timer = setTimeout(say, wait);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: compares each new set of rows with the last
  useLayoutEffect(() => {
    if (!highlight || !getRowId) return;
    const next = snapshotOf(
      rows.map((r) => ({
        id: r.id,
        cells: r.getAllCells().map((c) => [c.column.id, c.getValue()] as [string, unknown]),
      })),
    );
    const was = snapshot.current;
    snapshot.current = { key: resetKey, rows: next };
    if (!was || was.key !== resetKey) return;
    const { changed, added } = diffSnapshots(
      was.rows,
      next,
      rows.map((r) => r.id),
    );
    if (changed.length === 0 && added.length === 0) return;
    setFlash((f) => ({ ...f, cells: new Set([...f.cells, ...changed]), rows: new Set([...f.rows, ...added]) }));
    later(duration, () =>
      setFlash((f) => ({
        ...f,
        cells: new Set([...f.cells].filter((k) => !changed.includes(k))),
        rows: new Set([...f.rows].filter((k) => !added.includes(k))),
      })),
    );
    const changedRows = new Set(changed.map((k) => k.slice(0, k.indexOf("\u0000")))).size;
    announce(changedRows, added.length);
  }, [rows]);

  // ---------------------------------------------------------------- live lists: keep the top row

  const top = useRef<{ id: string; offset: number; index: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the rows change, before paint
  useLayoutEffect(() => {
    const el = scroller.current;
    const was = top.current;
    if (anchorTopRow && getRowId && el && was && el.scrollTop > 0) {
      const index = rows.findIndex((r) => r.id === was.id);
      // set directly, before paint: the virtualizer follows the scroll event
      if (index >= 0 && index * rowHeight + was.offset !== el.scrollTop) el.scrollTop = index * rowHeight + was.offset;
      // rows arrived above the view: the header says so
      if (highlight && index > was.index) {
        setFlash((f) => ({ ...f, above: true }));
        later(duration, () => setFlash((f) => ({ ...f, above: false })));
      }
    }
  }, [rows]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const remember = () => {
      const i = Math.floor(el.scrollTop / rowHeight);
      const row = table.getRowModel().rows[i];
      top.current = row ? { id: row.id, offset: el.scrollTop - i * rowHeight, index: i } : null;
    };
    remember();
    el.addEventListener("scroll", remember, { passive: true });
    return () => el.removeEventListener("scroll", remember);
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the caller says the list is a new one
  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [resetKey]);

  // ---------------------------------------------------------------- the grid: focus and editing

  const [focus, setFocus] = useState<{ rowId: string; col: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const wantsFocus = useRef(false);
  const lastRowIndex = useRef(0);
  const found = focus ? rows.findIndex((r) => r.id === focus.rowId) : -1;
  // the focused row left (deleted, filtered out): stay at its position
  const focusRow = found >= 0 ? found : Math.min(lastRowIndex.current, rows.length - 1);
  if (found >= 0) lastRowIndex.current = found;
  const focusCol = Math.min(focus?.col ?? 0, columnIds.length - 1);
  const onCellFocus = useRef(grid?.onCellFocus);
  onCellFocus.current = grid?.onCellFocus;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a move of the current cell reports
  useEffect(() => {
    const row = focus ? rows.find((r) => r.id === focus.rowId) : undefined;
    if (row && focus) onCellFocus.current?.(row.original, columnIds[focus.col] ?? "");
  }, [focus?.rowId, focus?.col]);

  /** Scrolls a row into the view (below the sticky header), setting scrollTop directly. */
  const reveal = (index: number) => {
    const el = scroller.current;
    if (!el) return;
    const view = (el.clientHeight || el.offsetHeight) - HEADER_HEIGHT;
    const y = index * rowHeight;
    let next = el.scrollTop;
    if (y < el.scrollTop) next = y;
    else if (y + rowHeight > el.scrollTop + view) next = y + rowHeight - view;
    if (next !== el.scrollTop) {
      el.scrollTop = next;
      el.dispatchEvent(new Event("scroll"));
    }
  };

  const moveTo = (row: number, col: number) => {
    const r = Math.max(0, Math.min(rows.length - 1, row));
    const c = Math.max(0, Math.min(columnIds.length - 1, col));
    const target = rows[r];
    if (!target) return;
    wantsFocus.current = true;
    setFocus({ rowId: target.id, col: c });
    reveal(r);
  };

  // Whether the focus is in the grid. A focused cell whose row goes away (deleted, live) takes the focus
  // down with it to <body>, without a blur; the grid then puts it on the current cell, now a neighbour.
  const hasFocus = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the rows change, before paint
  useLayoutEffect(() => {
    const active = document.activeElement;
    // lost: on <body>, or still pointing at the removed cell until the browser catches up
    if (grid && hasFocus.current && (!active || active === document.body || !active.isConnected))
      wantsFocus.current = true;
  }, [rows]);

  const firstRequest = useRef(focusRequest);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the caller asks
  useLayoutEffect(() => {
    if (grid && focusRequest !== firstRequest.current) wantsFocus.current = true;
  }, [focusRequest]);

  // after a keyboard move (or the end of an edit), focus the cell once it is rendered
  useLayoutEffect(() => {
    if (!wantsFocus.current || editing) return;
    const cell = scroller.current?.querySelector<HTMLElement>(`[data-cell="${focusRow}:${focusCol}"]`);
    if (cell) {
      wantsFocus.current = false;
      cell.focus({ preventScroll: true });
    }
  });

  const pageRows = () => {
    const el = scroller.current;
    const h = el ? (el.clientHeight || el.offsetHeight) - HEADER_HEIGHT : 0;
    return Math.max(1, Math.floor(h / rowHeight) - 1);
  };

  const startEdit = (rowIndex: number, col: number) => {
    const row = rows[rowIndex];
    if (!row || !grid) return;
    const columnId = columnIds[col]!;
    if (grid.renderEditor && grid.canEdit?.(row.original, columnId)) {
      setFocus({ rowId: row.id, col });
      setEditing(true);
    } else grid.onCellActivate?.(row.original, columnId);
  };

  const endEdit = (outcome: EditOutcome) => {
    setEditing(false);
    wantsFocus.current = true;
    if (outcome === "right") moveTo(focusRow, focusCol + 1);
  };

  // the context menu: at the pointer, or (from the keyboard) at the cell's corner
  const [menu, setMenu] = useState<{ rowId: string; col: number; x: number; y: number } | null>(null);
  const openMenu = (rowIndex: number, col: number, at?: { x: number; y: number }) => {
    const row = rows[rowIndex];
    if (!row || !grid?.cellMenu || columnIds[col] === SELECT_COLUMN) return false;
    const r = scroller.current?.querySelector(`[data-cell="${rowIndex}:${col}"]`)?.getBoundingClientRect();
    setFocus({ rowId: row.id, col });
    setMenu({ rowId: row.id, col, ...(at ?? { x: r?.left ?? 0, y: r?.bottom ?? 0 }) });
    return true;
  };
  const menuRow = menu ? rows.find((r) => r.id === menu.rowId) : undefined;

  const onGridKey = (e: KeyboardEvent<HTMLElement>, rowIndex: number, col: number) => {
    if (e.target !== e.currentTarget) return; // keys inside an editor are the editor's
    const current = rows[rowIndex];
    if (
      (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey) || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) &&
      openMenu(rowIndex, col)
    ) {
      e.preventDefault();
      return;
    }
    if (
      current &&
      columnIds[col] !== SELECT_COLUMN &&
      grid?.onCellKey?.(e, { row: current.original, columnId: columnIds[col]! })
    ) {
      e.preventDefault();
      return;
    }
    if (columnIds[col] === SELECT_COLUMN && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      const row = rows[rowIndex];
      if (row) toggle(row.id, e.shiftKey);
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const moves: Record<string, () => void> = {
      ArrowDown: () => moveTo(rowIndex + 1, col),
      ArrowUp: () => moveTo(rowIndex - 1, col),
      ArrowRight: () => moveTo(rowIndex, col + 1),
      ArrowLeft: () => moveTo(rowIndex, col - 1),
      Home: () => moveTo(ctrl ? 0 : rowIndex, 0),
      End: () => moveTo(ctrl ? rows.length - 1 : rowIndex, columnIds.length - 1),
      PageDown: () => moveTo(rowIndex + pageRows(), col),
      PageUp: () => moveTo(rowIndex - pageRows(), col),
      Enter: () => startEdit(rowIndex, col),
      F2: () => startEdit(rowIndex, col),
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      move();
    }
  };

  // ---------------------------------------------------------------- render

  const before = items[0]?.start ?? 0;
  const after = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);
  const captionId = useId();

  return (
    <section
      ref={scroller}
      data-slot="data-table"
      className={cn("relative max-h-[70vh] overflow-auto border", className)}
      aria-labelledby={captionId}
      onFocus={() => {
        hasFocus.current = true;
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hasFocus.current = false;
      }}
      // a grid's cells take the focus; a plain table's region must, to be scrolled with the keyboard
      // (WCAG 2.1.1, axe scrollable-region-focusable)
      tabIndex={grid && rows.length > 0 ? undefined : 0}
    >
      <table
        className="group/grid min-w-full table-fixed border-collapse text-sm"
        // fixed layout: the widths below are the columns' widths; a wider view stretches them evenly
        style={{ width: columnIds.reduce((sum, id) => sum + widthOf(id), 0) }}
        role={grid ? "grid" : undefined}
        aria-rowcount={rows.length + 1}
        aria-colcount={grid ? columnIds.length : undefined}
      >
        <caption id={captionId} className="sr-only">
          {label}
        </caption>
        <colgroup>
          {columnIds.map((id) => (
            <col key={id} style={{ width: widthOf(id) }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-muted text-left">
          {table.getHeaderGroups().map((group) => (
            <tr
              key={group.id}
              aria-rowindex={1}
              data-new-above={flash.above || undefined}
              className={cn(
                flash.above && "animate-highlight-border motion-reduce:shadow-[inset_0_-2px_0_0_var(--info)]",
              )}
            >
              {group.headers.map((header, i) => (
                <th
                  key={header.id}
                  scope="col"
                  aria-colindex={grid ? i + 1 : undefined}
                  className="relative h-9 truncate border-r border-b px-3 font-medium whitespace-nowrap last:border-r-0"
                >
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  {onColumnStateChange && header.column.id !== SELECT_COLUMN && (
                    <ResizeHandle
                      label={`Resize ${header.column.id}`}
                      value={widthOf(header.column.id)}
                      min={MIN_WIDTH}
                      max={MAX_WIDTH}
                      onDrag={(width) => setDragging({ id: header.column.id, width: clampWidth(width) })}
                      onCommit={(width) => {
                        setDragging(null);
                        setWidth(header.column.id, width);
                      }}
                    />
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columnIds.length} className="px-3 py-8 text-center text-muted-foreground">
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
                const rowFocused = grid && item.index === focusRow;
                return (
                  <tr
                    key={row.id}
                    aria-rowindex={item.index + 2}
                    style={{ height: rowHeight }}
                    data-added={flash.rows.has(row.id) || undefined}
                    className={cn(
                      "border-b last:border-b-0",
                      rowFocused && "bg-muted/40",
                      flash.rows.has(row.id) && "animate-highlight motion-reduce:bg-highlight",
                      !grid &&
                        onRowActivate &&
                        "cursor-pointer outline-none hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    )}
                    tabIndex={!grid && onRowActivate ? 0 : undefined}
                    onClick={!grid && onRowActivate ? () => onRowActivate(row.original) : undefined}
                    onKeyDown={
                      !grid && onRowActivate
                        ? (e) => {
                            if (e.key === "Enter") onRowActivate(row.original);
                          }
                        : undefined
                    }
                  >
                    {row.getAllCells().map((cell, col) => {
                      const changed = flash.cells.has(cellKey(row.id, cell.column.id));
                      const flashing = changed && "animate-highlight motion-reduce:bg-highlight";
                      if (!grid)
                        return (
                          <td
                            key={cell.id}
                            data-changed={changed || undefined}
                            className={cn("truncate border-r px-3 whitespace-nowrap last:border-r-0", flashing)}
                          >
                            <table.FlexRender cell={cell} />
                          </td>
                        );
                      const isFocus = item.index === focusRow && col === focusCol;
                      // nothing is selected until a click or a key picks a cell
                      const selected = isFocus && focus !== null;
                      const isEditing = isFocus && editing;
                      return (
                        <td
                          key={cell.id}
                          // implicit in a role="grid" table (HTML-AAM), but stated for every tool that
                          // does not derive it
                          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a data grid's cell is a gridcell
                          role="gridcell"
                          aria-colindex={col + 1}
                          aria-selected={selected || undefined}
                          data-changed={changed || undefined}
                          data-cell={`${item.index}:${col}`}
                          tabIndex={isFocus && !isEditing ? 0 : -1}
                          aria-readonly={
                            cell.column.id === SELECT_COLUMN || grid.canEdit?.(row.original, cell.column.id)
                              ? undefined
                              : true
                          }
                          className={cn(
                            "cursor-default border-r px-3 whitespace-nowrap outline-none last:border-r-0",
                            cell.column.id === SELECT_COLUMN && "w-10",
                            isEditing ? "relative overflow-visible p-0" : "truncate",
                            // the current cell: strong while the grid has the focus, faint when it is elsewhere
                            selected && "ring-2 ring-ring/40 ring-inset group-focus-within/grid:ring-ring",
                            flashing,
                          )}
                          onFocus={(e) => {
                            // the first Tab into the grid lands on the default cell: it becomes the picked one
                            if (e.target === e.currentTarget && !selected) setFocus({ rowId: row.id, col });
                          }}
                          onMouseDown={() => {
                            if (isEditing) return;
                            if (editing) setEditing(false); // clicking another cell leaves the edit, unsaved
                            setFocus({ rowId: row.id, col });
                          }}
                          onClick={() => {
                            if (grid.activateOnClick && !isEditing && !grid.canEdit?.(row.original, cell.column.id))
                              grid.onCellActivate?.(row.original, cell.column.id);
                          }}
                          onDoubleClick={() => !isEditing && startEdit(item.index, col)}
                          onContextMenu={(e) => {
                            if (isEditing) return; // an editor's own menu (copy, paste)
                            if (openMenu(item.index, col, { x: e.clientX, y: e.clientY })) e.preventDefault();
                          }}
                          onKeyDown={(e) => onGridKey(e, item.index, col)}
                        >
                          {isEditing && grid.renderEditor ? (
                            grid.renderEditor({ row: row.original, columnId: cell.column.id, done: endEdit })
                          ) : (
                            <table.FlexRender cell={cell} />
                          )}
                        </td>
                      );
                    })}
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
      {grid?.cellMenu && (
        <DropdownMenu
          open={menu !== null && menuRow !== undefined}
          onOpenChange={(open, details) => {
            // Base UI reports a submenu opening as "a sibling opened" to a menu without a trigger
            if (open || details.reason === "sibling-open") return;
            setMenu(null);
            wantsFocus.current = true; // back to the cell (unless an item started an edit)
          }}
        >
          {menu && menuRow && (
            <DropdownMenuContent
              aria-label={`Actions on ${columnIds[menu.col]}`}
              className="w-auto min-w-48"
              side="bottom"
              align="start"
              sideOffset={0}
              finalFocus={false}
              anchor={{ getBoundingClientRect: () => DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }) }}
            >
              {grid.cellMenu({
                row: menuRow.original,
                columnId: columnIds[menu.col]!,
                edit: () => {
                  const i = rows.findIndex((r) => r.id === menu.rowId);
                  if (i >= 0) startEdit(i, menu.col);
                },
              })}
            </DropdownMenuContent>
          )}
        </DropdownMenu>
      )}
      {highlight?.announce && (
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
      )}
    </section>
  );
}

export { DataTable };

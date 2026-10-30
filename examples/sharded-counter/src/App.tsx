// One million checkboxes (after atrakh/one-million-checkboxes, as the sharded counter's own example): every box live,
// 4,000 to a document and one query per document, and the number checked from the sharded counter. A click flips
// its box and the count at once (an optimistic update), then the server confirms both.
import { useMutation, useQueries, useQuery } from "@bunvex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type CellComponentProps, Grid } from "react-window";
import { api } from "../bunvex/_generated/api";
import { isChecked, NUM_BOXES, NUM_DOCUMENTS, shiftBit } from "../bunvex/boxes";

/** The size of an element, kept up to date. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

export function App() {
  // One query per document, all live.
  const queries = useMemo(
    () =>
      Object.fromEntries(
        Array.from({ length: NUM_DOCUMENTS }, (_, documentIdx) => [
          String(documentIdx),
          { query: api.checkboxes.get, args: { documentIdx } },
        ]),
      ),
    [],
  );
  const documents = useQueries(queries);
  const boxes = Array.from({ length: NUM_DOCUMENTS }, (_, i) => documents[String(i)] as ArrayBuffer | undefined);
  const numCheckedBoxes = useQuery(api.checkboxes.countCheckedBoxes);
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const numColumns = Math.max(1, Math.ceil((width - 40) / 30));
  const numRows = Math.ceil(NUM_BOXES / numColumns);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", height: "95vh", width: "99vw" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontWeight: "bold", marginBottom: "0.25rem" }}>One Million Checkboxes</div>
          <div data-testid="count">{numCheckedBoxes ?? "…"} boxes checked</div>
        </div>
        <div style={{ marginLeft: "auto" }}>counted by @bunvex/sharded-counter</div>
      </div>
      <div style={{ width: "100%", height: "100%", flexGrow: 1 }} ref={ref}>
        <Grid
          cellComponent={Cell}
          cellProps={{ flattenedBoxes: boxes, numColumns }}
          columnCount={numColumns}
          columnWidth={30}
          rowCount={numRows}
          rowHeight={30}
          style={{ height, width }}
        />
      </div>
    </div>
  );
}

type CellProps = { flattenedBoxes: (ArrayBuffer | undefined)[]; numColumns: number };

function Cell({ style, rowIndex, columnIndex, flattenedBoxes, numColumns }: CellComponentProps<CellProps>) {
  // Neighbouring boxes are in different documents, so clicks nearby rarely touch the same one.
  const index = rowIndex * numColumns + columnIndex;
  const documentIdx = index % NUM_DOCUMENTS;
  const arrayIdx = Math.floor(index / NUM_DOCUMENTS);
  const document = flattenedBoxes[documentIdx];
  const checked = document !== undefined && isChecked(new Uint8Array(document), arrayIdx);
  const isLoading = document === undefined;

  const toggle = useMutation(api.checkboxes.toggle).withOptimisticUpdate((localStore) => {
    const current = localStore.getQuery(api.checkboxes.get, { documentIdx });
    if (current === undefined || current === null) return;
    const flipped = shiftBit(new Uint8Array(current.slice(0)), arrayIdx, !checked);
    if (!flipped) return;
    localStore.setQuery(api.checkboxes.get, { documentIdx }, flipped.buffer as ArrayBuffer);
    const count = localStore.getQuery(api.checkboxes.countCheckedBoxes, {});
    if (count !== undefined) localStore.setQuery(api.checkboxes.countCheckedBoxes, {}, count + (checked ? -1 : 1));
  });
  if (index >= NUM_BOXES) return null;
  return (
    <div style={style} id={`${documentIdx}-${arrayIdx}`}>
      <input
        style={{ margin: "0.25rem", cursor: isLoading ? undefined : "pointer", width: "24px", height: "24px" }}
        type="checkbox"
        checked={checked}
        disabled={isLoading}
        onChange={() => void toggle({ documentIdx, arrayIdx, checked: !checked })}
      />
    </div>
  );
}

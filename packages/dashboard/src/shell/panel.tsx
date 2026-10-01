// The side panel every screen uses (UI-01 §22.1, the owner's call, 1 Oct 2026 — superseding §12.5.6's drawer):
// **docked**, part of the layout beside the screen's content (which shrinks to make room), never floating
// over it, and **resizable** by dragging its left edge (the window-splitter pattern, ResizeHandle); its width
// is kept in this browser per kind of panel. Below `md` (a phone) there is no room side by side: it is a
// full-screen sheet. It never takes more than 45 % of its row, so the content keeps the rest. A complementary landmark named by its title; Escape or the close button closes it; on
// open it takes the focus (unless the screen keeps it, e.g. a list the panel follows), and on close the
// focus returns to what had it.
import { Button } from "@bunvex/ui/components/button";
import { ResizeHandle } from "@bunvex/ui/components/resize-handle";
import { X } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

const DEFAULT_WIDTH = 416;
export const PANEL_MIN = 288;
export const PANEL_MAX = 760;
const key = (kind: string) => `bunvex-dashboard:panel-width:${kind}`;

/** A kind of panel's width, kept in this browser; `undefined` puts the default back. */
export function usePanelWidth(kind: string): [number, (w: number | undefined) => void] {
  const [width, setState] = useState(() => {
    try {
      const w = Number(localStorage.getItem(key(kind)));
      return w >= PANEL_MIN && w <= PANEL_MAX ? w : DEFAULT_WIDTH;
    } catch {
      return DEFAULT_WIDTH;
    }
  });
  const set = (w: number | undefined) => {
    setState(w ?? DEFAULT_WIDTH);
    try {
      if (w === undefined) localStorage.removeItem(key(kind));
      else localStorage.setItem(key(kind), String(w));
    } catch {
      // for this page only
    }
  };
  return [width, set];
}

export function Panel(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Which width to keep, e.g. "database-document". Panels of one kind share it. */
  kind?: string;
  /** Default true. False when the screen keeps the focus (a list whose current row the panel follows). */
  focusOnOpen?: boolean;
}) {
  const { title, onClose, children } = props;
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const aside = useRef<HTMLElement>(null);
  const [width, setWidth] = usePanelWidth(props.kind ?? "panel");
  const [dragging, setDragging] = useState<number>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // focus in on open, back out on close — only where it was, and only if the focus was left in the panel
  const focusOnOpen = props.focusOnOpen ?? true;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per panel, when it opens and closes
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    if (focusOnOpen) heading.current?.focus({ preventScroll: true });
    const panel = aside.current;
    return () => {
      const active = document.activeElement;
      const leftInside = !active || active === document.body || (panel?.contains(active) ?? false);
      if (focusOnOpen && leftInside && before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  return (
    <aside
      ref={aside}
      aria-labelledby={titleId}
      data-slot="side-panel"
      className="fixed inset-0 z-30 flex flex-col overflow-hidden bg-background md:relative md:inset-auto md:z-auto md:w-[var(--panel-width)] md:max-w-[45%] md:shrink-0 md:border-l"
      style={{ "--panel-width": `${dragging ?? width}px` } as CSSProperties}
    >
      <header className="flex h-11 items-center gap-2 border-b px-4">
        <h2 ref={heading} id={titleId} tabIndex={-1} className="min-w-0 flex-1 truncate font-medium outline-none">
          {title}
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close the panel" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
      <ResizeHandle
        label="Resize the panel"
        edge="left"
        value={dragging ?? width}
        min={PANEL_MIN}
        max={PANEL_MAX}
        onDrag={setDragging}
        onCommit={(w) => {
          setDragging(undefined);
          setWidth(w);
        }}
        className="hidden md:block"
      />
    </aside>
  );
}

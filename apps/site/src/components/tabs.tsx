import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";

export type Tab = { id: string; label: ReactNode; panel: ReactNode };

/**
 * The WAI-ARIA tabs pattern: a tablist of buttons, one visible panel, arrow keys move between tabs. Every
 * panel is rendered (the others `hidden`), so the prerendered page holds all of the content.
 */
export function Tabs({
  tabs,
  label,
  className = "",
  listClassName = "",
  tabClassName,
  vertical = false,
}: {
  tabs: readonly Tab[];
  label: string;
  className?: string;
  listClassName?: string;
  tabClassName: (selected: boolean) => string;
  vertical?: boolean;
}) {
  const [selected, setSelected] = useState(0);
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent) {
    const next = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const to =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? tabs.length - 1
          : next
            ? (selected + next + tabs.length) % tabs.length
            : -1;
    if (to < 0) return;
    e.preventDefault();
    setSelected(to);
    refs.current[to]?.focus();
  }

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        aria-orientation={vertical ? "vertical" : "horizontal"}
        className={listClassName}
        onKeyDown={onKeyDown}
      >
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={i === selected}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={i === selected ? 0 : -1}
            className={tabClassName(i === selected)}
            onClick={() => setSelected(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t, i) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={i !== selected}
          className="min-w-0"
        >
          {t.panel}
        </div>
      ))}
    </div>
  );
}

// A side panel beside a screen's list (UI-01 §12.3): a drawer over the list on narrow screens, beside it
// from 2xl up; Escape or the close button closes it.
import { Button } from "@bunvex/ui/components/button";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useId } from "react";

export function Panel({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside
      aria-labelledby={titleId}
      className="fixed inset-y-0 right-0 z-30 flex w-full flex-col overflow-hidden border-l bg-background shadow-xl sm:w-[28rem] 2xl:static 2xl:z-auto 2xl:w-[26rem] 2xl:shrink-0 2xl:shadow-none"
    >
      <header className="flex h-11 items-center gap-2 border-b px-4">
        <h2 id={titleId} className="min-w-0 flex-1 truncate font-medium">
          {title}
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close the panel" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </aside>
  );
}

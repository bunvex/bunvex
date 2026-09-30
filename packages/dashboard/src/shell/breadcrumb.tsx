// Where a nested screen sits: Tables › tasks › k1…. The last item is the current page.
import type { ReactNode } from "react";

export function Breadcrumb({ children }: { children: ReactNode }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground [&>li:not(:last-child)]:after:ml-1.5 [&>li:not(:last-child)]:after:content-['/']">
        {children}
      </ol>
    </nav>
  );
}

export const crumbLink =
  "underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring outline-none";

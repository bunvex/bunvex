import type { ReactNode } from "react";

/** A landing section: a labelled region with an h2, on the page's shared column. */
export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-16 border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-24">
        <h2 id={`${id}-title`} className="font-mono text-xl font-semibold tracking-tight sm:text-2xl">
          {title}
        </h2>
        <div className="mt-8">{children}</div>
      </div>
    </section>
  );
}

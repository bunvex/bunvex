import { SITE } from "../content.ts";

/** The wordmark: a provisional mark (a honey square with a violet offset) and the name (SITE-01 §4). */
export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5 font-mono text-lg font-medium">
      <span
        aria-hidden="true"
        className="inline-block size-3.5 rounded-[4px] bg-honey shadow-[5px_5px_0_var(--color-violet)]"
      />
      bunvex
    </span>
  );
}

const LINKS = [
  ["#benchmarks", "Benchmarks"],
  ["#features", "Features"],
  ["#migrate", "From Convex"],
  ["#status", "Status"],
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-page/90 backdrop-blur">
      <div className="mx-auto flex h-15 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <a href="/" className="no-underline">
          <Wordmark />
        </a>
        <nav aria-label="Main" className="ml-auto flex items-center gap-5 text-[14.5px] text-soft">
          {LINKS.map(([href, label]) => (
            <a key={href} href={href} className="hidden no-underline hover:text-ink md:inline">
              {label}
            </a>
          ))}
          <span aria-disabled="true" className="hidden cursor-default text-dim sm:inline">
            Docs <span className="text-xs">(soon)</span>
          </span>
          <a
            href={SITE.repo}
            className="rounded-lg border border-line px-3 py-1 text-ink no-underline hover:border-soft"
          >
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}

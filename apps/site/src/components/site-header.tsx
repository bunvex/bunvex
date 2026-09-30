import { SITE } from "../content.ts";
import { ClientThemeToggle } from "./client-theme-toggle.tsx";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <a href="/" className="font-mono text-base font-bold tracking-tight">
          bunvex
        </a>
        <nav aria-label="Main" className="ml-auto flex items-center gap-5 text-sm">
          <span aria-disabled="true" className="hidden cursor-default text-muted-foreground sm:inline">
            Docs <span className="text-xs">(soon)</span>
          </span>
          <a href="#benchmarks" className="hover:underline">
            Benchmarks
          </a>
          <a href={SITE.repo} className="hover:underline">
            GitHub
          </a>
          <ClientThemeToggle />
        </nav>
      </div>
    </header>
  );
}

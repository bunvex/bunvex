// The command palette (STUDY-12 §20, a bunvex addition; UI-01 §32): Ctrl/Cmd+K anywhere. One search over
// every screen (registered extensions too), the settings and auth pages, the deployment's tables and
// functions, a document by its id, and actions — each shown only when the source and the credential allow
// it. Keyboard-first: a combobox over a listbox (aria-activedescendant), ↑/↓ to move, Enter to pick, Escape
// to close. Loaded on first use, so the first load does not carry it.
import { Dialog, DialogContent, DialogTitle } from "@bunvex/ui/components/dialog";
import { cn } from "@bunvex/ui/lib/utils";
import { useOptionalTheme } from "@bunvex/ui/theme";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, functionsQuery, referenceQuery, tablesQuery } from "../data/queries.ts";
import { useExtensions } from "../extensions/context.ts";
import { offers } from "../extensions/types.ts";
import { useRunner } from "../runner/context.tsx";
import { GROUP_TITLES, looksLikeId, type PaletteItem, rememberPick, searchItems } from "./model.ts";

const SCREENS: [string, string, string[]?][] = [
  ["Overview", "/", ["health", "home"]],
  ["Topology", "/topology", ["nodes", "cluster"]],
  ["Database", "/database", ["tables", "data"]],
  ["Schema", "/schema"],
  ["Files", "/files", ["storage"]],
  ["Functions", "/functions"],
  ["Scheduled functions", "/schedules/functions", ["schedules"]],
  ["Cron jobs", "/schedules/crons", ["schedules"]],
  ["Authentication", "/auth", ["users"]],
  ["Logs", "/logs"],
  ["History", "/history", ["audit"]],
];
const SETTINGS: [string, string][] = [
  ["General", "/settings/general"],
  ["Environment variables", "/settings/environment-variables"],
  ["Snapshots", "/settings/snapshots"],
];
const AUTH_PAGES: [string, string][] = [
  ["Users", "users"],
  ["Sessions", "sessions"],
  ["Organizations", "organizations"],
  ["Sign in / Providers", "providers"],
  ["Multi-factor", "multi-factor"],
  ["Passkeys", "passkeys"],
  ["Session lifetime", "session-lifetime"],
  ["Rate limits", "rate-limits"],
  ["URL configuration", "urls"],
  ["Emails", "emails"],
  ["Auth audit", "audit"],
];

const recentKey = (scope: string) => `bunvex:palette-recent:${scope}`;
function readRecent(scope: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey(scope)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Every item the palette can offer right now. */
function useItems(query: string): PaletteItem[] {
  const qs = useQueryScope();
  const { data: caps } = useQuery(capabilitiesQuery(qs));
  const { data: tables = [] } = useQuery(tablesQuery(qs));
  const { data: functions = [] } = useQuery({
    ...functionsQuery(qs),
    enabled: typeof qs.source.listFunctions === "function",
  });
  const extensions = useExtensions();
  const runner = useRunner();
  const theme = useOptionalTheme();
  const currentTable = useRouterState({
    select: (s) =>
      (s.matches.find((m) => m.routeId === "/database/$table")?.params as { table?: string } | undefined)?.table,
  });
  const queryClient = useQueryClient();
  const router = useRouter();
  const canWrite = !!caps && !caps.readOnly && caps.operations.includes("writeData");
  const canPause = !!caps?.operations.includes("pauseDeployment");

  return useMemo(() => {
    const items: PaletteItem[] = [];
    for (const [title, to, keywords] of SCREENS)
      items.push({ id: `screen:${to}`, kind: "screen", title, keywords, go: { to } });
    for (const e of extensions.filter((e) => offers(qs.source, e))) {
      items.push({ id: `screen:${e.nav.to}`, kind: "screen", title: e.title, hint: "Extension", go: { to: e.nav.to } });
      for (const group of e.column ?? [])
        for (const it of group.items)
          if (it.to !== e.nav.to)
            items.push({ id: `screen:${it.to}`, kind: "screen", title: it.label, hint: e.title, go: { to: it.to } });
    }
    for (const t of tables)
      items.push({
        id: `table:${t.name}`,
        kind: "table",
        title: t.name,
        hint: `${t.documentCount} documents`,
        go: { to: `/database/${t.name}` },
      });
    for (const f of functions)
      items.push({
        id: `function:${f.path}`,
        kind: "function",
        title: f.path,
        hint: f.kind,
        go: { to: "/functions", search: { function: f.path } },
      });

    for (const [title, to] of SETTINGS)
      items.push({ id: `setting:${to}`, kind: "setting", title, hint: "Settings", go: { to } });
    if (typeof qs.source.listClientApps === "function")
      items.push({
        id: "setting:/settings/apps",
        kind: "setting",
        title: "Apps",
        hint: "Settings",
        go: { to: "/settings/apps" },
      });
    for (const [title, section] of AUTH_PAGES)
      items.push({
        id: `setting:auth:${section}`,
        kind: "setting",
        title,
        hint: "Authentication",
        go: { to: `/auth/${section}` },
      });
    // a document by its id, when the source can say which table it is in
    const id = query.trim();
    if (looksLikeId(id) && typeof qs.source.tableOfId === "function")
      items.push({
        id: `document:${id}`,
        kind: "document",
        title: `Open document ${id}`,
        run: () => {
          void queryClient.fetchQuery(referenceQuery(qs, id)).then((table) => {
            if (table) void router.navigate({ to: `/database/${table}`, search: { doc: id } } as never);
          });
        },
      });

    if (theme)
      items.push({
        id: "action:theme",
        kind: "action",
        title: theme.resolvedTheme === "dark" ? "Switch to the light theme" : "Switch to the dark theme",
        keywords: ["theme", "dark", "light"],
        run: () => theme.setTheme(theme.resolvedTheme === "dark" ? "light" : "dark"),
      });
    if (runner.available)
      items.push({
        id: "action:runner",
        kind: "action",
        title: "Run a function",
        keywords: ["runner"],
        run: () => runner.open(),
      });
    if (currentTable && canWrite && typeof qs.source.insertDocuments === "function")
      items.push({
        id: "action:add-documents",
        kind: "action",
        title: `Add documents to ${currentTable}`,
        go: { to: `/database/${currentTable}`, search: { panel: "add" } },
      });
    if (typeof qs.source.pauseDeployment === "function" && canPause)
      items.push({
        id: "action:pause",
        kind: "action",
        title: "Pause or resume the deployment…",
        hint: "Settings → General",
        go: { to: "/settings/general" },
      });
    return items;
  }, [qs, tables, functions, extensions, runner, theme, currentTable, query, queryClient, router, canWrite, canPause]);
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { scope } = useQueryScope();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState(() => readRecent(scope));
  const close = () => onOpenChange(false);
  const all = useItems(query);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  // empty query: the recent picks first, then everything by group
  const shown = useMemo(() => {
    if (query.trim() !== "") return searchItems(all, query);
    const byId = new Map(all.map((i) => [i.id, i]));
    const rec = recent.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    return [...rec, ...all.filter((i) => !recent.includes(i.id))].slice(0, 60);
  }, [all, query, recent]);
  const recentCount = query.trim() === "" ? recent.filter((id) => all.some((i) => i.id === id)).length : 0;

  // a new query starts at the best match
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query is the trigger
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (open) {
      setQuery("");
      setRecent(readRecent(scope));
    }
  }, [open, scope]);
  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  const pick = (item: PaletteItem | undefined) => {
    if (!item) return;
    const next = rememberPick(recent, item.id);
    try {
      localStorage.setItem(recentKey(scope), JSON.stringify(next));
    } catch {
      // storage off: nothing is remembered
    }
    close();
    if ("go" in item) void router.navigate({ to: item.go.to, search: item.go.search } as never);
    else item.run();
  };

  // a heading where the group changes: "Recent" first, then each kind (only without a query)
  const headingOf = (i: number) =>
    i < recentCount ? "Recent" : query.trim() === "" ? GROUP_TITLES[shown[i]!.kind] : null;
  const rows: ({ heading: string } | { item: PaletteItem; index: number })[] = [];
  shown.forEach((item, index) => {
    const heading = headingOf(index);
    if (heading && (index === 0 || headingOf(index - 1) !== heading)) rows.push({ heading });
    rows.push({ item, index });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={inputRef} aria-describedby={undefined}>
        <DialogTitle className="sr-only">Go to or do anything</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={shown.length ? `${listId}-${active}` : undefined}
            aria-label="Search screens, tables, functions and actions"
            placeholder="Search screens, tables, functions, actions…"
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(shown.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Home" && e.ctrlKey) {
                setActive(0);
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(shown[active]);
              }
            }}
          />
        </div>
        <div role="listbox" id={listId} aria-label="Results" className="max-h-[min(60svh,26rem)] overflow-y-auto py-1">
          {shown.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches “{query}”.</p>
          )}
          {rows.map((r) =>
            "heading" in r ? (
              <div
                key={`h-${r.heading}-${rows.indexOf(r)}`}
                role="presentation"
                className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground"
              >
                {r.heading}
              </div>
            ) : (
              // biome-ignore lint/a11y/useFocusableInteractive: the input keeps the focus (aria-activedescendant)
              // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard picks through the input
              <div
                key={r.item.id}
                id={`${listId}-${r.index}`}
                role="option"
                aria-selected={r.index === active}
                onMouseMove={() => setActive(r.index)}
                onClick={() => pick(r.item)}
                className={cn(
                  "mx-1 flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm",
                  r.index === active && "bg-muted",
                )}
              >
                <span className="min-w-0 truncate">{r.item.title}</span>
                {r.item.hint && <span className="min-w-0 truncate text-xs text-muted-foreground">{r.item.hint}</span>}
                {r.index === active && (
                  <CornerDownLeft className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
              </div>
            ),
          )}
        </div>
        <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">↑ ↓ to move · Enter to open · Esc to close</p>
      </DialogContent>
    </Dialog>
  );
}

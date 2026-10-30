// The Database screen's component (STUDY-152 §4), as Convex's dashboard picks one (`useNents.ts`,
// `NentSwitcherList.tsx`): the installed components listed after "app", the unmounted ones last and marked `*`,
// the choice in the URL (`?component=<_components id>`; an id the list does not have is the app's). The screen
// then reads and writes in that component's namespace: everything under `DatabaseScope` uses the component's
// source and cache keys. An unmounted component's data is read-only, as Convex's.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@bunvex/ui/components/select";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Puzzle } from "lucide-react";
import { createContext, type ReactNode, useContext, useId, useMemo } from "react";
import { QueryScopeContext, useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import { componentScope, componentsQuery, type QueryScope } from "../data/queries.ts";
import type { ComponentInfo } from "../data-source.ts";

/** The app's scope, under a component's (the component list is the app's). */
const AppScopeContext = createContext<QueryScope | null>(null);

/** The component the Database screen shows (null: the app's tables). */
const SelectedComponentContext = createContext<ComponentInfo | null>(null);
export const useSelectedComponent = () => useContext(SelectedComponentContext);

/** The `component` of the Database screen's URL, to keep on a link to another of its tables. */
export function useComponentSearch(): { component: string | undefined } {
  const { component } = useSearch({ strict: false }) as { component?: string };
  return { component };
}

/** The installed components, read again when a push mounts or unmounts one. */
export function useComponents(): ComponentInfo[] {
  const current = useQueryScope();
  const app = useContext(AppScopeContext) ?? current;
  const queryClient = useQueryClient();
  const query = componentsQuery(app);
  useWatch<void>(
    (onChange, onError) => app.source.watchComponents?.(() => onChange(undefined), onError) ?? (() => {}),
    () => void queryClient.invalidateQueries({ queryKey: query.queryKey }),
    [app.source, app.scope, queryClient],
  );
  return useQuery(query).data ?? [];
}

/** The Database screen in its component's scope (the app's for none). */
export function DatabaseScope({ children }: { children: ReactNode }) {
  const app = useQueryScope();
  const components = useComponents();
  const { component } = useComponentSearch();
  const scope = useMemo(() => componentScope(app, components, component), [app, components, component]);
  const selected = scope === app ? null : (components.find((c) => c.id === component) ?? null);
  return (
    <AppScopeContext.Provider value={app}>
      <QueryScopeContext.Provider value={scope}>
        <SelectedComponentContext.Provider value={selected}>{children}</SelectedComponentContext.Provider>
      </QueryScopeContext.Provider>
    </AppScopeContext.Provider>
  );
}

const APP = "";

/** Convex's component picker: shown only when the app uses components. Picking one opens its first table. */
export function ComponentPicker({ className }: { className?: string }) {
  const components = useComponents();
  const selected = useSelectedComponent();
  const navigate = useNavigate();
  const labelId = useId();
  if (components.length === 0) return null;
  const ordered = [
    ...components.filter((c) => c.state === "active"),
    ...components.filter((c) => c.state !== "active"),
  ];
  const label = (c: ComponentInfo) => `${c.path}${c.state === "active" ? "" : "*"}`;
  return (
    <div className={className}>
      <span id={labelId} className="sr-only">
        Component
      </span>
      <Select
        items={[{ value: APP, label: "app" }, ...ordered.map((c) => ({ value: c.id, label: label(c) }))]}
        value={selected?.id ?? APP}
        onValueChange={(v) =>
          void navigate({ to: "/database", search: { component: v === APP ? undefined : (v as string) } })
        }
      >
        <SelectTrigger
          aria-labelledby={labelId}
          title="Switch between components installed in this deployment."
          className="h-7 w-full"
        >
          <Puzzle className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={APP}>app</SelectItem>
          {ordered.map((c) => (
            <SelectItem
              key={c.id}
              value={c.id}
              title={c.state === "active" ? undefined : "This component is unmounted"}
            >
              {label(c)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected && selected.state !== "active" && (
        <p className="mt-1 text-xs text-muted-foreground">This component is unmounted. Its data is read-only.</p>
      )}
    </div>
  );
}

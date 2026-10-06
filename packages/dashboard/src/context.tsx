// What every screen reads besides the router: the injected data source and the scope of its query keys.
import { createContext, useContext } from "react";
import type { QueryScope } from "./data/queries.ts";

export const QueryScopeContext = createContext<QueryScope | null>(null);

export function useQueryScope(): QueryScope {
  const ctx = useContext(QueryScopeContext);
  if (!ctx) throw new Error("dashboard components must be rendered inside <Dashboard>");
  return ctx;
}

export const useDataSource = () => useQueryScope().source;

/** The host's trace UI URL template (`DashboardProps.traceUrl`, STUDY-131 AD-27); undefined when unset. */
export const TraceUrlContext = createContext<string | undefined>(undefined);

/**
 * A trace's address in the host's trace UI: `{traceId}` and `{spanId}` in the template are replaced; a template
 * without `{traceId}` gets the trace id appended (a base URL such as Jaeger's `…/trace/`). Undefined when no
 * template is set.
 */
export function traceHref(template: string | undefined, trace: { traceId: string; spanId: string }) {
  if (!template) return undefined;
  const id = encodeURIComponent(trace.traceId);
  const span = encodeURIComponent(trace.spanId);
  return template.includes("{traceId}")
    ? template.replaceAll("{traceId}", id).replaceAll("{spanId}", span)
    : `${template}${id}`;
}

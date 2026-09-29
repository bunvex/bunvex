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

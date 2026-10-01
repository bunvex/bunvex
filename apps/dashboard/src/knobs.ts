// The mock's knobs for development (`?latency=300&fail=0.2&writes=500`). They share the page's query with
// the route's own search (`/database/users?panel=schema&writes=0`), so they are read once, kept for the tab
// (sessionStorage, so a reload keeps them) and taken out of the address before the router starts — the
// route's parameters stay.
const KEY = "bunvex:dashboard-dev-knobs";
const KNOBS = ["latency", "fail", "writes", "tables", "tasks", "executions", "nodes"] as const;

type Env = {
  location: Pick<Location, "search" | "pathname" | "hash">;
  history: Pick<History, "state" | "replaceState">;
  storage?: Pick<Storage, "getItem" | "setItem">;
};

export function takeDevKnobs({ location, history, storage }: Env): URLSearchParams {
  const query = new URLSearchParams(location.search);
  const fromUrl = new URLSearchParams();
  for (const k of KNOBS) {
    const v = query.get(k);
    if (v === null) continue;
    fromUrl.set(k, v);
    query.delete(k);
  }
  if (fromUrl.size > 0) {
    try {
      storage?.setItem(KEY, fromUrl.toString());
    } catch {
      // storage off (private window): the knobs last until the next reload
    }
    const rest = query.toString();
    history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
    return fromUrl;
  }
  try {
    return new URLSearchParams(storage?.getItem(KEY) ?? "");
  } catch {
    return new URLSearchParams();
  }
}

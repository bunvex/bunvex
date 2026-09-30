// The mock's knobs for development (`?latency=300&fail=0.2&writes=500`). They sit in the page's query,
// but the hash history reads that query as the route's search too (TanStack's createHashHistory takes
// `location.search` for it), so the first navigation copied them into the hash route. They are read once,
// kept for the tab (sessionStorage, so a reload keeps them) and taken out of the address.
const KEY = "bunvex:dashboard-dev-knobs";

type Env = {
  location: Pick<Location, "search" | "pathname" | "hash">;
  history: Pick<History, "state" | "replaceState">;
  storage?: Pick<Storage, "getItem" | "setItem">;
};

export function takeDevKnobs({ location, history, storage }: Env): URLSearchParams {
  const fromUrl = new URLSearchParams(location.search);
  if (fromUrl.size > 0) {
    try {
      storage?.setItem(KEY, fromUrl.toString());
    } catch {
      // storage off (private window): the knobs last until the next reload
    }
    history.replaceState(history.state, "", `${location.pathname}${location.hash}`);
    return fromUrl;
  }
  try {
    return new URLSearchParams(storage?.getItem(KEY) ?? "");
  } catch {
    return new URLSearchParams();
  }
}

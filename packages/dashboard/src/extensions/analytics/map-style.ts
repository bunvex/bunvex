// The Realtime map's style (STUDY-12 §16, follow-up 2 Oct 2026): by default the bundled, offline basemap
// (Natural Earth countries, no request leaves the dashboard); optionally a richer MapLibre style from a URL the
// reader gives — kept in this browser per deployment, since it is a viewer's preference, not the
// deployment's. Such a style fetches its tiles, fonts and sprites from a third party, which the page says.
const key = (scope: string) => `bunvex:analytics-map-style:${scope}`;

export function readMapStyle(scope: string): string | null {
  try {
    return localStorage.getItem(key(scope));
  } catch {
    return null;
  }
}

export function writeMapStyle(scope: string, url: string | null) {
  try {
    if (url) localStorage.setItem(key(scope), url);
    else localStorage.removeItem(key(scope));
  } catch {
    // storage off: the style lasts for this visit
  }
}

/** Why a URL cannot be a style URL, or `undefined`. https only (http on localhost, for a style served nearby). */
export function mapStyleProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "Not a URL: write the full address, starting with https://";
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    return "The style must be served over https (http only on localhost).";
  return undefined;
}

/** A fetched document is a MapLibre style when it has `version: 8`, `sources` and `layers`. */
export function isMapLibreStyle(doc: unknown): boolean {
  if (!doc || typeof doc !== "object") return false;
  const d = doc as { version?: unknown; sources?: unknown; layers?: unknown };
  return d.version === 8 && typeof d.sources === "object" && d.sources !== null && Array.isArray(d.layers);
}

// Canonical URLs (STUDY-49), as Convex's `_canonical_urls` (crates/model/src/canonical_urls,
// local_backend/src/canonical_urls.rs): an operator may set the public URL of the API (`bunvexCloud`) or of
// HTTP actions (`bunvexSite`). It replaces the server's origin in `BUNVEX_CLOUD_URL` / `BUNVEX_SITE_URL`,
// in file upload and download URLs, and for `auth.config`. It is read in the caller's transaction, so a
// change re-runs what read it. Convex's destinations are `convexCloud` and `convexSite` (rule 5: bunvex's
// own words, DV-263).
import { CANONICAL_URLS_TABLE, type Tx } from "@bunvex/core";

export type RequestDestination = "bunvexCloud" | "bunvexSite";
export const REQUEST_DESTINATIONS: readonly RequestDestination[] = ["bunvexCloud", "bunvexSite"];

export type CanonicalUrls = { cloud: string | null; site: string | null };

type Row = { _id: string; requestDestination: RequestDestination; url: string };

const rows = (db: Tx) => db.asSystem(() => db.query(CANONICAL_URLS_TABLE).collect()) as unknown as Promise<Row[]>;

/** The canonical URLs set, read in `db`'s transaction (its read set). */
export async function readCanonicalUrls(db: Tx): Promise<CanonicalUrls> {
  const out: CanonicalUrls = { cloud: null, site: null };
  for (const r of await rows(db)) {
    if (r.requestDestination === "bunvexCloud") out.cloud = r.url;
    else if (r.requestDestination === "bunvexSite") out.site = r.url;
  }
  return out;
}

/** Convex's `set_canonical_url` / `unset_canonical_url`: replace (or remove) the destination's row. */
export async function setCanonicalUrl(db: Tx, destination: RequestDestination, url: string | null) {
  for (const r of await rows(db))
    if (r.requestDestination === destination) {
      if (url !== null && r.url === url) return;
      await db.asSystem(() => db.delete(CANONICAL_URLS_TABLE, r._id));
    }
  if (url !== null) await db.asSystem(() => db.insert(CANONICAL_URLS_TABLE, { requestDestination: destination, url }));
}

/** The built-in variables with the canonical URLs in place of the server's origins. */
export const withCanonical = (builtin: Record<string, string>, c: CanonicalUrls): Record<string, string> => ({
  ...builtin,
  ...(c.cloud === null ? {} : { BUNVEX_CLOUD_URL: c.cloud }),
  ...(c.site === null ? {} : { BUNVEX_SITE_URL: c.site }),
});

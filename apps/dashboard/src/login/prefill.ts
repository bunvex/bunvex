// The sign-in page's prefill (STUDY-149 PR 7). Convex's self-hosted dashboard takes it from
// NEXT_PUBLIC_DEPLOYMENT_URL / NEXT_PUBLIC_ADMIN_KEY, read by its server each time the page is served
// (`_app.tsx` `getInitialProps`), so the image's environment sets it. bunvex's app is static: the server that
// serves it (`bunvex dashboard serve`, the image's; its BUNVEX_DEPLOYMENT_URL / BUNVEX_ADMIN_KEY) writes them into
// index.html as `<meta name="bunvex-deployment-url">` / `<meta name="bunvex-admin-key">`. A build's own
// VITE_BUNVEX_DEPLOYMENT_URL / VITE_BUNVEX_ADMIN_KEY are the fallback.

export const DEPLOYMENT_URL_META = "bunvex-deployment-url";
export const ADMIN_KEY_META = "bunvex-admin-key";

export type Prefill = { deploymentUrl?: string; adminKey?: string };

const meta = (doc: Pick<Document, "querySelector">, name: string) =>
  doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content") || undefined;

/** The server's values first, then the build's; unset when neither has one. */
export function readPrefill(doc: Pick<Document, "querySelector">, build: Prefill): Prefill {
  return {
    deploymentUrl: meta(doc, DEPLOYMENT_URL_META) ?? (build.deploymentUrl || undefined),
    adminKey: meta(doc, ADMIN_KEY_META) ?? (build.adminKey || undefined),
  };
}

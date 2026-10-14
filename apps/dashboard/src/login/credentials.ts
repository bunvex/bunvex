// Signing the dashboard in to a deployment (STUDY-12 §19): a deployment URL and an admin key, checked by a
// verifier before the screens open — as Convex's self-hosted dashboard does (`checkDeploymentInfo.ts`:
// `GET /api/check_admin_key` with the key → `{ allowedOps, isReadOnly }`). The verifier and the mapping of the
// server's operations live in @bunvex/dashboard-source (STUDY-149); this module adds what the form needs.

export {
  type AdminCredentials,
  type AdminKeyCheck,
  type AdminKeyVerifier,
  capabilitiesOf,
  INVALID_CREDENTIALS,
} from "@bunvex/dashboard-source/credentials";

/**
 * A deployment URL as typed, made canonical (`http(s)://host[:port][/path]`, no trailing slash), or why not.
 * A bare host gets `http://` for a local address and `https://` otherwise.
 */
export function normalizeDeploymentUrl(input: string): { ok: true; url: string } | { ok: false; error: string } {
  const text = input.trim();
  if (text === "") return { ok: false, error: "Enter the deployment URL." };
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/.test(text);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${local ? "http" : "https"}://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: "This is not a URL. For example: http://127.0.0.1:3210" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, error: "The URL must start with http:// or https://." };
  if (url.search || url.hash) return { ok: false, error: "The URL can't have a query or a fragment." };
  return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

/** The deployment's name as the key carries it (`<name>|…`), for the header. */
export const deploymentNameOf = (adminKey: string) => adminKey.split("|", 1)[0]?.trim() || undefined;

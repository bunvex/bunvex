// Convex's health routes (`crates/local_backend/src/router.rs` `health_check_routes`) and its meta `/version`
// (`crates/common/src/http/mod.rs` `meta_routes`): no auth, plain text. STUDY-112.
import pkg from "../package.json";

/**
 * The server's version, as Convex's `SERVER_VERSION_STR` (its release version): the `@bunvex/server` package's
 * semver (DV-373). `/version` and `/instance_version` answer it.
 */
export const SERVER_VERSION: string = pkg.version;

/** Convex's `MAX_ECHO_BYTES` default (`crates/common/src/knobs.rs`): the largest body `/echo` takes, 128 MiB. */
export const MAX_ECHO_BYTES = 128 * 1024 * 1024;

/**
 * The `/echo` limit from the environment: `MAX_ECHO_BYTES` as Convex's knob (a non-negative integer), else
 * 128 MiB. Convex declares it but does not enforce it; bunvex does (DV-375).
 */
export function maxEchoBytesFromEnv(env = process.env): number {
  const raw = env.MAX_ECHO_BYTES;
  if (raw === undefined || raw === "") return MAX_ECHO_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`MAX_ECHO_BYTES: not a non-negative integer: ${raw}`);
  return n;
}

/** What `GET /` answers: bunvex's own sentence (DV-374). */
export const ROOT_TEXT = "This bunvex deployment is running.";

/** Axum's answer to a method a route does not take: 405, no body, the methods it does take. */
const methodNotAllowed = (allow: string) => new Response(null, { status: 405, headers: { allow } });

/** A `get(...)` route: GET (and HEAD, which axum answers from it) or a 405. */
const getOnly = (req: Request, text: () => string) =>
  req.method === "GET" || req.method === "HEAD" ? new Response(text()) : methodNotAllowed("GET,HEAD");

/** The meta `GET /version`, on the API and the site port alike (DV-147). */
export const versionRoute = (req: Request) => getOnly(req, () => SERVER_VERSION);

/**
 * `POST /echo`, which `npx convex network-test` times: the body back as it comes, streamed. A declared length
 * past `limit` is a 413 before a byte is read; a body without a length is cut off there (the answer has
 * already started, so the connection breaks instead).
 */
function echo(req: Request, limit: number): Response {
  if (req.method !== "POST") return methodNotAllowed("POST");
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return new Response("Payload Too Large", { status: 413 });
  if (!req.body) return new Response(null);
  if (declared !== null) return new Response(req.body);
  let seen = 0;
  return new Response(
    req.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, c) {
          seen += chunk.byteLength;
          if (seen > limit) c.error(new Error("Request body too large"));
          else c.enqueue(chunk);
        },
      }),
    ),
  );
}

/** The health routes, or `null` for another path. */
export function healthRoute(
  req: Request,
  pathname: string,
  instanceName: string,
  maxEchoBytes = MAX_ECHO_BYTES,
): Response | null {
  switch (pathname) {
    case "/version":
      return versionRoute(req);
    case "/instance_name":
      return getOnly(req, () => instanceName);
    case "/instance_version":
      return getOnly(req, () => SERVER_VERSION);
    case "/":
      return getOnly(req, () => ROOT_TEXT);
    case "/echo":
      return echo(req, maxEchoBytes);
    default:
      return null;
  }
}

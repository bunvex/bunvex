// The sign-in route (STUDY-202 §1.5), v2's `ssr/signInProxy.ts` in bunvex's words. Under server rendering a method's
// usual client hook calls its sign-in function through this route instead of the deployment: the route speaks the HTTP
// client's wire (the client's address is the route plus `?path=`, so `<route>?path=/api/mutation` arrives here), forwards
// the call when the function is on the app's list, and on the way back moves the minted refresh token into its httpOnly
// cookie, leaving the page the access token. Adding a method is adding its function to the list: no route, no client
// code. The wire is bunvex's: the `encoded_json` format (DV-307) and the `Bunvex-Client` header (DV-315).
import { getFunctionName } from "@bunvex/client";
import type { DefaultFunctionArgs, FunctionReference } from "@bunvex/server";
import { makeSlimBundle, type SignInEnvelope, type TokenBundle } from "../lib/types.ts";
import { type AuthCookieOptions, writeAuthCookies } from "./cookies.ts";
import type { RequestHandler } from "./handlers.ts";
import { httpCookies } from "./httpCookies.ts";
import { forbiddenOriginResponse, isTrustedOrigin } from "./origin.ts";

/** A sign-in function the route may forward to: public, and returning the shared sign-in result. */
export type ExposedSignInFn = FunctionReference<"mutation" | "action", "public", DefaultFunctionArgs, SignInEnvelope>;

/** What {@link bunvexProxyHandler} needs. */
export interface BunvexProxyConfig {
  /** The deployment's URL, as the server reaches it. */
  bunvexUrl: string;
  /**
   * Every function of the app that signs a user in (creates a session and returns its tokens). The route refuses any
   * other: this list is all it serves.
   */
  signIn: ExposedSignInFn[];
  /** The session cookies' attributes. */
  cookieOptions: AuthCookieOptions;
  /** Origins trusted besides the request's own `Host` (see {@link isTrustedOrigin}). */
  allowedOrigins?: string[];
}

const KINDS = ["query", "mutation", "action"] as const;
type Kind = (typeof KINDS)[number];

// The status of a function that threw: its error is in the body, for the client to rethrow.
const FUNCTION_FAILED = 560;

// The endpoint the client appended to the address, now the `path` parameter.
function kindOf(url: URL): Kind | null {
  const path = url.searchParams.get("path");
  return KINDS.find((kind) => path === `/api/${kind}`) ?? null;
}

type Call = { path: string; args: unknown[] };

// The HTTP client's call: the function's name, its one argument object, encoded as the client encodes it.
function parseCall(body: unknown): Call | null {
  if (typeof body !== "object" || body === null) return null;
  const { path, format, args } = body as Record<string, unknown>;
  if (typeof path !== "string" || format !== "encoded_json") return null;
  if (!Array.isArray(args) || args.length !== 1) return null;
  return { path, args };
}

function isTokenBundle(value: unknown): value is TokenBundle {
  if (typeof value !== "object" || value === null) return false;
  const bundle = value as Record<string, unknown>;
  return (
    typeof bundle.accessToken === "string" &&
    typeof bundle.refreshToken === "string" &&
    typeof bundle.refreshTokenExpiresAt === "number" &&
    typeof bundle.userId === "string"
  );
}

// A sign-in result, told apart by its `status`: a session to keep, or a refusal to pass on. Anything else is not a
// sign-in result, and nothing of it reaches the page.
function classify(value: unknown): { kind: "session"; tokens: TokenBundle } | { kind: "forward" } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { status, tokens } = value as Record<string, unknown>;
  if (status === "complete") return isTokenBundle(tokens) ? { kind: "session", tokens } : null;
  if (status === "error") return tokens === undefined ? { kind: "forward" } : null;
  return null;
}

const text = (status: number, message: string) =>
  new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * The sign-in route, mounted once at a fixed path (`POST`). It serves every function in `signIn`, each reachable from
 * its method's usual client hook. It answers as the deployment would, except that a sign-in's refresh token goes into
 * its httpOnly cookie instead of the body. Refused: a cross-site request (403), a path that is not a function endpoint
 * (404), a body that is not a call (400), a function not on the list (403), and a result that is not a sign-in's (500).
 */
export function bunvexProxyHandler(config: BunvexProxyConfig): RequestHandler {
  const allowed = new Set(config.signIn.map((fn) => getFunctionName(fn)));
  return async (request) => {
    if (!isTrustedOrigin(request, config.allowedOrigins)) return forbiddenOriginResponse();
    const kind = kindOf(new URL(request.url));
    if (kind === null) return text(404, "Not an auth proxy endpoint.");
    let call: Call | null;
    try {
      call = parseCall(await request.json());
    } catch {
      call = null;
    }
    if (call === null) return text(400, "Malformed function call.");
    if (!allowed.has(call.path)) return text(403, `${call.path} is not exposed through the auth proxy.`);

    // The caller's client header and token go along (a sign-in may link to the signed-in user); its cookies do not.
    const client = request.headers.get("bunvex-client");
    const authorization = request.headers.get("authorization");
    const upstream = await fetch(`${config.bunvexUrl}/api/${kind}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(client !== null && { "bunvex-client": client }),
        ...(authorization !== null && { authorization }),
      },
      body: JSON.stringify({ path: call.path, format: "encoded_json", args: call.args }),
    });
    if (!upstream.ok && upstream.status !== FUNCTION_FAILED) return text(upstream.status, await upstream.text());
    const payload = (await upstream.json()) as Record<string, unknown>;
    if (payload.status !== "success") return Response.json(payload, { status: upstream.status });

    const result = classify(payload.value);
    if (result === null)
      return text(
        500,
        `${call.path} did not return a sign-in result. The sign-in functions must return the shared envelope ` +
          `({ status: "complete", tokens } or { status: "error", userError }).`,
      );
    if (result.kind === "forward") return Response.json(payload, { status: upstream.status });

    const cookies = httpCookies(request);
    await writeAuthCookies(cookies, result.tokens, config.cookieOptions);
    (payload.value as Record<string, unknown>).tokens = makeSlimBundle(result.tokens);
    const response = Response.json(payload, { status: upstream.status });
    cookies.applyTo(response.headers);
    return response;
  };
}

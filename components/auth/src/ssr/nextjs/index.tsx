// `@bunvex/auth/ssr/nextjs` (STUDY-202 §1.7), v2's `./ssr/nextjs` in bunvex's names (C-4): the session under Next.js's
// App Router. `proxy.ts` (Next 16's middleware) refreshes the access token before a page renders and decides redirects;
// Server Components and Server Actions read the token from its cookie; a server provider hands it to the client one.
// The routes themselves (sign-in, refresh, sign-out) are `@bunvex/auth/ssr`'s handlers, mounted under `app/auth/`.
import { BunvexHttpClient } from "@bunvex/client";
import { getFunctionName } from "@bunvex/server";
import { cookies as nextCookies } from "next/headers.js";
import { connection, type NextRequest, NextResponse } from "next/server.js";
import type { ReactNode } from "react";
import type { IsAuthenticatedFn, RefreshSessionFn } from "../../lib/types.ts";
import {
  AUTH_JWT_COOKIE,
  type AuthCookieOptions,
  type CookieDeleteOptions,
  type CookieOptions,
  type CookieStore,
} from "../cookies.ts";
import { createServerAuthChecker } from "../isAuthenticated.ts";
import { isTokenExpiring } from "../jwt.ts";
import { ServerAuthSession } from "../session.ts";

/** What {@link setupBunvexAuthNextjs} needs. */
export interface BunvexAuthNextjsConfig {
  /** The deployment's URL. */
  bunvexUrl: string;
  /** The app's `refreshSession` mutation. */
  refreshSession: RefreshSessionFn;
  /**
   * The app's `isAuthenticated` query, used twice: the server asks the deployment with it whether the access token
   * names a live session (instead of trusting the cookie), and the client provider subscribes to it, so a session
   * revoked on the server signs the browser out at once instead of at its next refresh.
   */
  isAuthenticated: IsAuthenticatedFn;
  /**
   * The session cookies' attributes, as given to `setupBunvexAuthServer`. `secure` defaults to whether
   * `NODE_ENV` is `production` (`next build` and `next start`), so the cookies also work over http on `next dev`.
   */
  cookieOptions?: Partial<AuthCookieOptions>;
}

/** What the handler of {@link setupBunvexAuthNextjs}'s proxy gets beside the request. */
export interface BunvexAuthNextjsProxyCtx {
  /** Whether the request is signed in, asked of the deployment. */
  isAuthenticated: () => Promise<boolean>;
  /** The request's access token, refreshed if it was about to expire; `null` when signed out. */
  getToken: () => Promise<string | null>;
}

/** An app's own proxy logic: a response (a redirect, say), or nothing to let the request through. */
export type BunvexAuthNextjsProxyHandler = (
  request: NextRequest,
  ctx: BunvexAuthNextjsProxyCtx,
) => Promise<NextResponse | undefined | void> | NextResponse | undefined | void;

/** A redirect to `path` on the request's own origin. */
function nextjsProxyRedirect(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url));
}

// The proxy's cookies: the request's, under what this request wrote, and the writes kept in order for the response.
class ProxyCookieStore implements CookieStore {
  readonly #request: NextRequest;
  readonly #written = new Map<string, string | null>();
  readonly #operations: Array<
    | { kind: "set"; name: string; value: string; options?: CookieOptions }
    | { kind: "delete"; name: string; options?: CookieDeleteOptions }
  > = [];

  constructor(request: NextRequest) {
    this.#request = request;
  }

  get(name: string): string | undefined {
    if (this.#written.has(name)) return this.#written.get(name) ?? undefined;
    return this.#request.cookies.get(name)?.value;
  }

  set(name: string, value: string, options?: CookieOptions): void {
    this.#written.set(name, value);
    this.#operations.push({ kind: "set", name, value, options });
  }

  delete(name: string, options?: CookieDeleteOptions): void {
    this.#written.set(name, null);
    this.#operations.push({ kind: "delete", name, options });
  }

  applyTo(response: NextResponse): void {
    for (const op of this.#operations) {
      if (op.kind === "set") response.cookies.set(op.name, op.value, op.options);
      // The path and domain the cookie was written with, or the deletion misses it.
      else response.cookies.delete({ name: op.name, ...op.options });
    }
  }
}

/**
 * Configure the session's Next.js side once, and get what an app mounts:
 *
 * ```ts
 * // lib/auth.ts
 * export const { bunvexAuthNextjsProxy, nextjsProxyRedirect, bunvexAuthNextjsAccessToken, isAuthenticatedNextjs,
 *   BunvexAuthNextjsServerProvider } = setupBunvexAuthNextjs({
 *   bunvexUrl: process.env.NEXT_PUBLIC_BUNVEX_URL!,
 *   refreshSession: api.auth.refreshSession,
 *   isAuthenticated: api.auth.isAuthenticated,
 * });
 * ```
 */
export function setupBunvexAuthNextjs(config: BunvexAuthNextjsConfig) {
  const http = new BunvexHttpClient(config.bunvexUrl);
  const cookieOptions: AuthCookieOptions = {
    ...config.cookieOptions,
    secure: config.cookieOptions?.secure ?? process.env.NODE_ENV === "production",
  };
  const newSession = (cookies: CookieStore) =>
    new ServerAuthSession({
      refreshSession: (refreshToken) => http.mutation(config.refreshSession, { refreshToken }),
      cookies,
      cookieOptions,
    });
  // The deployment checks the signature and the session, so a forged cookie is not signed in.
  const checkAuthenticated = createServerAuthChecker({
    bunvexUrl: config.bunvexUrl,
    isAuthenticated: config.isAuthenticated,
  });

  /**
   * The proxy (`export default` it from `proxy.ts`): it refreshes the access token when it is about to expire, so the
   * page renders with a fresh one, then runs `handler`, if given, for redirects. The cookies it rewrote go on the
   * response, the handler's or the one that lets the request through.
   */
  function bunvexAuthNextjsProxy(handler?: BunvexAuthNextjsProxyHandler) {
    return async (request: NextRequest): Promise<NextResponse> => {
      const cookies = new ProxyCookieStore(request);
      const session = newSession(cookies);
      await session.getToken();
      let response: NextResponse | undefined;
      if (handler) {
        const result = await handler(request, {
          isAuthenticated: async () => checkAuthenticated(await session.getToken()),
          getToken: () => session.getToken(),
        });
        if (result) response = result;
      }
      response ??= NextResponse.next();
      cookies.applyTo(response);
      return response;
    };
  }

  /**
   * The access token, for a Server Component or a Server Action to call the deployment with: the cookie's, or `null`
   * when there is none or it has expired. It never refreshes (a Server Component cannot set cookies): the proxy has.
   */
  async function bunvexAuthNextjsAccessToken(): Promise<string | null> {
    const token = (await nextCookies()).get(AUTH_JWT_COOKIE)?.value ?? null;
    if (token === null) return null;
    // The expiry reads the clock, which Next refuses in a prerender (Cache Components) until the render opts into
    // request time; reading cookies alone does not.
    await connection();
    return isTokenExpiring(token, 0) ? null : token;
  }

  /** Whether the request is signed in, asked of the deployment, for a Server Component or a Server Action. */
  async function isAuthenticatedNextjs(): Promise<boolean> {
    return checkAuthenticated(await bunvexAuthNextjsAccessToken());
  }

  /**
   * Put this in your root layout, around the app: it reads the access token on the server and renders the client
   * provider with it, so the first paint is signed in. The routes are `/auth/signin`, `/auth/refresh` and
   * `/auth/signout`.
   */
  async function BunvexAuthNextjsServerProvider({ children }: { children: ReactNode }) {
    const initialToken = await bunvexAuthNextjsAccessToken();
    // Imported here, so a server module that only reads the token does not load the client's code.
    const { BunvexAuthNextjsProvider } = await import("./client.tsx");
    return (
      <BunvexAuthNextjsProvider
        bunvexUrl={config.bunvexUrl}
        initialToken={initialToken}
        // A function reference does not survive the trip to the client (it is a proxy); its name, a string, does.
        isAuthenticatedFunctionName={getFunctionName(config.isAuthenticated)}
      >
        {children}
      </BunvexAuthNextjsProvider>
    );
  }

  return {
    bunvexAuthNextjsProxy,
    nextjsProxyRedirect,
    bunvexAuthNextjsAccessToken,
    isAuthenticatedNextjs,
    BunvexAuthNextjsServerProvider,
  };
}

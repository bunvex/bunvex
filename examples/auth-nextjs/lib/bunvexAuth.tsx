// Next.js's side of the session: the proxy (a refresh before each page, and the redirects of `proxy.ts`), the token for
// Server Components, and the provider that hands it to the client.
import { setupBunvexAuthNextjs } from "@bunvex/auth/ssr/nextjs";
import { api } from "../bunvex/_generated/api";

export const {
  bunvexAuthNextjsProxy,
  nextjsProxyRedirect,
  bunvexAuthNextjsAccessToken,
  isAuthenticatedNextjs,
  BunvexAuthNextjsServerProvider,
} = setupBunvexAuthNextjs({
  bunvexUrl: process.env.NEXT_PUBLIC_BUNVEX_URL!,
  refreshSession: api.auth.refreshSession,
  isAuthenticated: api.auth.isAuthenticated,
});

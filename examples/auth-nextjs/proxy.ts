// Before each page: the access token refreshed if it is about to expire, then the redirects. Signed out, every page but
// the sign-in page goes to it; signed in, the sign-in page goes home.
import { bunvexAuthNextjsProxy, nextjsProxyRedirect } from "./lib/bunvexAuth";

export default bunvexAuthNextjsProxy(async (request, { isAuthenticated }) => {
  const onSignIn = request.nextUrl.pathname === "/signin";
  const signedIn = await isAuthenticated();
  if (!onSignIn && !signedIn) return nextjsProxyRedirect(request, "/signin");
  if (onSignIn && signedIn) return nextjsProxyRedirect(request, "/");
});

export const config = {
  // Everything but the session's routes (they keep their own cookies) and Next's files.
  matcher: ["/((?!auth(?:/|$)|_next/static|_next/image|favicon.ico).*)"],
};

// The sign-in route: it serves every function `lib/serverAuth.ts` lists, forwarding each call to the deployment and
// moving the refresh token it returns into an httpOnly cookie. Adding a method is adding its function to that list.
import { auth } from "../../../lib/serverAuth";

export const POST = auth.bunvexProxyHandler;

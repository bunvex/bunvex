import { preloadQuery } from "@bunvex/nextjs";
import { api } from "../bunvex/_generated/api";
import { bunvexAuthNextjsAccessToken } from "../lib/bunvexAuth";
import { Account } from "./Account";

// A Server Component: the user read with the cookie's access token, so the page arrives signed in, then kept live.
export default async function Home() {
  const token = await bunvexAuthNextjsAccessToken();
  const preloaded = await preloadQuery(api.users.loggedInUser, {}, { token: token ?? undefined });
  return <Account preloaded={preloaded} />;
}

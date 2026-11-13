"use client";

import { useAuthActions, useAuthToken } from "@bunvex/auth/react";
import { type Preloaded, usePreloadedQuery } from "@bunvex/react";
import { useRouter } from "next/navigation";
import type { api } from "../bunvex/_generated/api";

export function Account({ preloaded }: { preloaded: Preloaded<typeof api.users.loggedInUser> }) {
  const user = usePreloadedQuery(preloaded);
  const token = useAuthToken();
  const { signOut } = useAuthActions();
  const router = useRouter();
  return (
    <main>
      <h1>bunvex auth + Next.js</h1>
      <p>
        Signed in as <strong data-testid="user">{user ? user.username : "(signed out)"}</strong>.
      </p>
      <p>
        The page holds the access token alone (<code>{token ? `${token.slice(0, 16)}…` : "none"}</code>); the refresh
        token is in an httpOnly cookie, out of the page's reach.
      </p>
      <button
        type="button"
        onClick={async () => {
          await signOut();
          router.push("/signin");
        }}
      >
        Sign out
      </button>
    </main>
  );
}

"use client";

import { BunvexProvider, BunvexReactClient } from "bunvex/react";
import { type ReactNode, useState } from "react";

// `bunvex dev` writes the deployment's URL to .env.local as NEXT_PUBLIC_BUNVEX_URL.
export function BunvexClientProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new BunvexReactClient(process.env.NEXT_PUBLIC_BUNVEX_URL as string));
  return <BunvexProvider client={client}>{children}</BunvexProvider>;
}

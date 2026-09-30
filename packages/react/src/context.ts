// The client a component tree shares (Convex's `ConvexProvider` / `useConvex`).
import { createContext, createElement, type ReactNode, useContext } from "react";
import type { BunvexReactClient } from "./client.ts";

const BunvexContext = createContext<BunvexReactClient>(undefined as unknown as BunvexReactClient);

/** The client of the nearest `BunvexProvider`. */
export function useBunvex(): BunvexReactClient {
  return useContext(BunvexContext);
}

/** Give `client` to every component below. */
export function BunvexProvider({ client, children }: { client: BunvexReactClient; children?: ReactNode }) {
  return createElement(BunvexContext.Provider, { value: client }, children);
}

/** The client, or the error Convex gives a hook used outside its provider. */
export function useRequiredClient(hook: string): BunvexReactClient {
  const client = useContext(BunvexContext);
  if (client === undefined)
    throw new Error(
      `Could not find bunvex client! \`${hook}\` must be used in the React component tree under \`BunvexProvider\`. Did you forget it?`,
    );
  return client;
}

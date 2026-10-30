// The router, with a TanStack Query client whose queries are bunvex queries. On the server, a page's queries are read
// over HTTP at one snapshot, and their results go to the browser with the page; there the same queries continue as
// live subscriptions, so the page shows the server's data at once and updates as it changes.
import { BunvexProvider } from "@bunvex/react";
import { BunvexQueryClient } from "@bunvex/react-query";
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  // `bunvex dev` writes the local deployment's URL to .env.local as VITE_BUNVEX_URL.
  const url = import.meta.env.VITE_BUNVEX_URL;
  if (!url) throw new Error("VITE_BUNVEX_URL is not set: start the app with `bun run dev`");
  const bunvexQueryClient = new BunvexQueryClient(url);
  const queryClient: QueryClient = new QueryClient({
    defaultOptions: { queries: { queryKeyHashFn: bunvexQueryClient.hashFn(), queryFn: bunvexQueryClient.queryFn() } },
  });
  bunvexQueryClient.connect(queryClient);

  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    context: { queryClient },
    scrollRestoration: true,
    Wrap: ({ children }) => <BunvexProvider client={bunvexQueryClient.bunvexClient}>{children}</BunvexProvider>,
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

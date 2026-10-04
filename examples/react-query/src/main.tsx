import { BunvexQueryClient } from "@bunvex/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BunvexProvider, BunvexReactClient } from "bunvex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

// `bunvex dev` writes the deployment's URL to .env.local as VITE_BUNVEX_URL.
const bunvex = new BunvexReactClient(import.meta.env.VITE_BUNVEX_URL as string);
// The bunvex queries of this QueryClient stay live: their new results are pushed into its cache.
const bunvexQueryClient = new BunvexQueryClient(bunvex);
const queryClient = new QueryClient({
  defaultOptions: { queries: { queryKeyHashFn: bunvexQueryClient.hashFn(), queryFn: bunvexQueryClient.queryFn() } },
});
bunvexQueryClient.connect(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BunvexProvider client={bunvex}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </BunvexProvider>
  </StrictMode>,
);

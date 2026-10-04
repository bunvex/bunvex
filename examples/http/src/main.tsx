import { BunvexProvider, BunvexReactClient } from "bunvex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

// `bunvex dev` writes the deployment's URL to .env.local as VITE_BUNVEX_URL (and the HTTP actions' origin as
// VITE_BUNVEX_SITE_URL).
const bunvex = new BunvexReactClient(import.meta.env.VITE_BUNVEX_URL as string);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BunvexProvider client={bunvex}>
      <App />
    </BunvexProvider>
  </StrictMode>,
);

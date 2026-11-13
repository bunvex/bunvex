import { BunvexAuthProvider } from "@bunvex/auth/react";
import { BunvexReactClient } from "@bunvex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../bunvex/_generated/api";
import { App } from "./App.tsx";
import "./index.css";

// `bunvex dev` writes the deployment's URL to .env.local as VITE_BUNVEX_URL.
const bunvex = new BunvexReactClient(import.meta.env.VITE_BUNVEX_URL as string);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* In place of BunvexProvider: it keeps the session, refreshes its token and signs the client in; it signs the
        client out as soon as the session is revoked on the server (another session changed the password, say). */}
    <BunvexAuthProvider
      client={bunvex}
      api={{
        refreshSession: api.auth.refreshSession,
        signOut: api.auth.signOut,
        isAuthenticated: api.auth.isAuthenticated,
      }}
    >
      <App />
    </BunvexAuthProvider>
  </StrictMode>,
);

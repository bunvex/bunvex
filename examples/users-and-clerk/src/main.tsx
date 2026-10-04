import { ClerkProvider, useAuth } from "@clerk/clerk-react";
import { BunvexReactClient } from "bunvex/react";
import { BunvexProviderWithClerk } from "bunvex/react-clerk";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const bunvex = new BunvexReactClient(import.meta.env.VITE_BUNVEX_URL as string);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Your Clerk publishable key, in .env.local as VITE_CLERK_PUBLISHABLE_KEY. */}
    <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string}>
      <BunvexProviderWithClerk client={bunvex} useAuth={useAuth}>
        <App />
      </BunvexProviderWithClerk>
    </ClerkProvider>
  </StrictMode>,
);

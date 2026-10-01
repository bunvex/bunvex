// The mock's authentication providers (UI-01 §19.1): what an app with Clerk-style OIDC and a custom JWT
// issuer would declare in `auth.config.ts`.
import type { AuthProvider } from "../data-source.ts";

export const SAMPLE_AUTH_PROVIDERS: AuthProvider[] = [
  { domain: "https://clerk.example.dev", applicationID: "bunvex" },
  {
    type: "customJwt",
    issuer: "https://auth.example.com",
    jwks: "https://auth.example.com/.well-known/jwks.json",
    algorithm: "RS256",
    applicationID: "bunvex-app",
  },
];

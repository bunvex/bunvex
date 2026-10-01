# @bunvex/auth

Identity for bunvex functions (STUDY-27): the auth config, JWT / OIDC verification, and the `UserIdentity`
`ctx.auth.getUserIdentity()` returns, as Convex's.

```ts
// bunvex/auth.config.ts
export default {
  providers: [
    { domain: "https://your-app.clerk.accounts.dev", applicationID: "convex" }, // OIDC
    { type: "customJwt", issuer: "https://auth.example.com", jwks: "https://auth.example.com/jwks", algorithm: "RS256" },
  ],
};

// the server
import authConfig from "./bunvex/auth.config.ts";
createServer({ engine, functions, auth: authConfig });

// a function
export const me = query(async ({ auth }) => (await auth.getUserIdentity())?.tokenIdentifier ?? null);
```

- `parseAuthConfig`: validation, with Convex's checks and messages.
- `TokenVerifier`: OIDC discovery + JWKS (RS256, EdDSA), custom JWT (RS256, ES256; 5 s leeway), cached by
  `Cache-Control`, with a refetch on an unknown `kid`.
- `UserIdentity`: `tokenIdentifier` (`issuer|subject`), the standard claims, custom claims.

# @bunvex/auth

Identity for bunvex functions: the auth config, JWT / OIDC verification, and the `UserIdentity`
`ctx.auth.getUserIdentity()` returns.

```ts
// bunvex/auth.config.ts
export default {
  providers: [
    { domain: "https://your-app.clerk.accounts.dev", applicationID: "bunvex" }, // OIDC
    { type: "customJwt", issuer: "https://auth.example.com", jwks: "https://auth.example.com/jwks", algorithm: "RS256" },
  ],
};

// the server
import authConfig from "./bunvex/auth.config.ts";
createServer({ engine, functions, auth: authConfig });

// a function
export const me = query(async ({ auth }) => (await auth.getUserIdentity())?.tokenIdentifier ?? null);
```

- `parseAuthConfig`: the config's validation, and its error messages.
- `TokenVerifier`: OIDC discovery + JWKS (RS256, EdDSA), custom JWT (RS256, ES256; 5 s leeway), cached by
  `Cache-Control`, with a refetch on an unknown `kid`.
- `UserIdentity`: `tokenIdentifier` (`issuer|subject`), the standard claims, custom claims.

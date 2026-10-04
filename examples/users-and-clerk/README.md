# Users with Clerk

Signed-in users, with Clerk for sign-in:

- `src/main.tsx` wraps the app in Clerk's `ClerkProvider` and `BunvexProviderWithClerk` (`bunvex/react-clerk`),
  which hands Clerk's tokens to the client.
- `bunvex/auth.config.ts` trusts your Clerk instance (its issuer, in the deployment's `CLERK_JWT_ISSUER_DOMAIN`
  variable) for tokens whose audience is `bunvex`.
- Once signed in, the page calls `users:store`, which keeps one row per identity (by the token's
  `tokenIdentifier`) in the `users` table, with the name kept current.
- `messages:send` posts as the stored user; `messages:list` joins each message with its author's name.

Setup:

1. In Clerk's dashboard, create a JWT template named **bunvex** (its audience is then `bunvex`).
2. Put your publishable key in `.env.local` as `VITE_CLERK_PUBLISHABLE_KEY`.
3. ```sh
   bun install
   bunx bunvex env set CLERK_JWT_ISSUER_DOMAIN https://<your-instance>.clerk.accounts.dev
   bun run dev
   ```

`auth.config.ts` reads the issuer as `process.env.CLERK_JWT_ISSUER_DOMAIN`; typed declarations of a deployment's
variables come with `defineApp`. Its end-to-end test (`test/e2e.test.ts`) replaces Clerk with a local OpenID
Connect issuer that signs the same tokens, so it needs no Clerk account.

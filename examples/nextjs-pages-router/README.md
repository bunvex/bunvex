# Next.js Pages Router

A counter in a Next.js Pages Router app (`pages/`):

- `pages/_app.tsx` creates the client from `NEXT_PUBLIC_BUNVEX_URL` (which `bunvex dev` writes to `.env.local`)
  and wraps every page in `BunvexProvider`;
- `pages/index.tsx` shows the counter with `useQuery`, live, and adds to it with `useMutation`;
- `pages/api/clicks.ts`, an API route, reads it on the server with `fetchQuery` from `bunvex/nextjs`.

The Convex demo of the same name signs users in with Auth0; that part is optional and left out here (see
`@bunvex/react-auth0` for `BunvexProviderWithAuth0`). `next.config.ts` lists bunvex's packages in
`transpilePackages`: they are published as TypeScript sources for now.

```sh
bun install
bun run dev   # starts a local deployment, pushes the functions, then `next dev`
```

Its end-to-end test (`test/e2e.test.ts`) deploys it, follows the counter through the client, runs
`next build`, then `next start`, and reads the page and the API route.

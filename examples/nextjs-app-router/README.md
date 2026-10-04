# Next.js App Router

A counter in a Next.js App Router app (`app/`):

- `app/page.tsx`, a Server Component, reads the counter with `preloadQuery` from `bunvex/nextjs`: the value is
  in the HTML from the first byte;
- `app/Counter.tsx`, a Client Component, takes it with `usePreloadedQuery` from `bunvex/react` and keeps it
  live; its button calls `useMutation(api.counters.increment)`;
- `app/server-only/page.tsx` uses only Server Components and a Server Action (`fetchQuery`, `fetchMutation`):
  not live, no client JavaScript;
- `app/BunvexClientProvider.tsx` creates the client from `NEXT_PUBLIC_BUNVEX_URL`, which `bunvex dev` writes to
  `.env.local`.

`next.config.ts` lists bunvex's packages in `transpilePackages`: they are published as TypeScript sources for
now.

```sh
bun install
bun run dev   # starts a local deployment, pushes the functions, then `next dev`
```

Its end-to-end test (`test/e2e.test.ts`) deploys it to a fresh backend, calls it as the Server Components and
the client do, and runs `next build`.

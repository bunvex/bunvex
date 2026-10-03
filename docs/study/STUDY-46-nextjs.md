# STUDY-46 — Next.js and server rendering: `fetchQuery`, `preloadQuery`, `usePreloadedQuery`

- **Status:** accepted: X1–X3 as recommended (owner, 2026-10-03)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-26](STUDY-26-sync-client.md) (the HTTP client, `validateDeploymentUrl`, C1; R3 deferred
  `usePreloadedQuery` to this package), [STUDY-40](STUDY-40-local-backend-and-local-deployments.md) (`bunvex dev`
  writes `NEXT_PUBLIC_BUNVEX_URL` to `.env.local` for a Next.js app), [client-sync.md §14](../parity/client-sync.md).

## 1. How Convex does it

Two files, both thin layers over pieces that already exist.

**`npm-packages/convex/src/nextjs/index.ts`** (`convex/nextjs`), for Server Components, Server Actions and Route
Handlers:

- `NextjsOptions = { token?, url?, adminToken? (internal), skipConvexDeploymentUrlCheck? }`.
- `fetchQuery(query, args?, options?)`, `fetchMutation(…)`, `fetchAction(…)`: each builds a new
  `ConvexHttpClient` (`setupClient`) and calls `client.query` / `mutation` / `action` with `fnArgs || {}`. The
  argument list is typed `ArgsAndOptions<F, NextjsOptions>` (`server/api.ts`): `[args?, options?]` when the
  function takes no arguments, else `[args, options?]`.
- `setupClient(options)`:
  - if `"url" in options && options.url === undefined` (an env variable that is not set, passed explicitly),
    `console.error("deploymentUrl is undefined, are your environment variables set? In the future explicitly
    passing undefined will cause an error. To explicitly use the default, pass
    `process.env.NEXT_PUBLIC_CONVEX_URL`.")`, then falls back to the default;
  - the URL is `options.url ?? process.env.NEXT_PUBLIC_CONVEX_URL`. Not a string: throws
    `Environment variable NEXT_PUBLIC_CONVEX_URL is not set.` when it came from the env, else
    `Convex function called with invalid deployment address.`;
  - unless `skipConvexDeploymentUrlCheck`, `validateDeploymentUrl(url)` (`common/index.ts`);
  - `token` → `client.setAuth(token)`; `adminToken` → `client.setAdminAuth(adminToken)`;
  - `client.setFetchOptions({ cache: "no-store" })`: Next.js must not cache these fetches.
- `preloadQuery(query, args?, options?)`: `fetchQuery`, then returns
  `{ _name: getFunctionName(query), _argsJSON: convexToJson(args[0] ?? {}), _valueJSON: convexToJson(value) }`.
  The `Preloaded` type says `_argsJSON: string` and `_valueJSON: string`, but the values are the JSON *values*
  `convexToJson` returns (objects, numbers, …), not strings: plain data a Server Component can pass to a Client
  Component as props.
- `preloadedQueryResult(preloaded)`: `jsonToConvex(preloaded._valueJSON)`, the value on the server.

**`npm-packages/convex/src/react/hydration.tsx`** (exported from `convex/react`):

- `type Preloaded<Query> = { __type: Query; _name: string; _argsJSON: string; _valueJSON: string }`; `__type`
  is a phantom field for the function's types.
- `usePreloadedQuery(preloaded)`: `args = jsonToConvex(_argsJSON)` and `preloadedResult = jsonToConvex(_valueJSON)`
  (each `useMemo`'d on its JSON), `result = useQuery(makeFunctionReference(_name), args)`, and returns
  `result === undefined ? preloadedResult : result`. The server's value until the subscription delivers, then
  the live value. A query error throws, as `useQuery`.

## 2. What an app can observe

- The four functions' names, argument shapes, return values and the `Preloaded` payload's fields and JSON
  encoding (an app may log it or pass it through its own serialization).
- `cache: "no-store"` on every request.
- The default URL from the public env variable, the console warning for an explicit `url: undefined`, and the
  two thrown messages; `validateDeploymentUrl`'s errors unless skipped.
- `token` sent as `Authorization: Bearer …`; `adminToken` as the admin header.
- `usePreloadedQuery`: the first render returns the preloaded value (no `undefined` flash), then follows the
  subscription; it needs the provider, as `useQuery`.

## 3. How bunvex does it

- **`@bunvex/nextjs`** (`packages/nextjs`), the package ARCHITECTURE.md plans and `scripts/check-deps.ts` already
  allows (`react`, `client`, `values`). Its `index.ts` holds `NextjsOptions`, `fetchQuery`, `fetchMutation`,
  `fetchAction`, `preloadQuery` and `preloadedQueryResult`, over `@bunvex/client`'s `BunvexHttpClient`
  (which already has `setAuth`, `setAdminAuth`, `setFetchOptions` and `skipDeploymentUrlCheck`), with
  `toJsonValue` / `fromJsonValue` from `@bunvex/values`.
- **`@bunvex/react`** gets `Preloaded` and `usePreloadedQuery` (a new `hydration.ts`), as Convex has them in
  `convex/react`: over the existing `useQuery` and `makeFunctionReference`.
- **`ArgsAndOptions`** joins `OptionalRestArgs` in `@bunvex/protocol`'s `api.ts`.
- No server change: these are HTTP API and sync calls the backend already serves.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| X1 | The default URL comes from `NEXT_PUBLIC_BUNVEX_URL`, not `NEXT_PUBLIC_CONVEX_URL`; the messages name it | rule 5; it is the name `bunvex dev` already writes to `.env.local` for a Next.js app (STUDY-40) | accepted (owner, 2026-10-03): DV-240 |
| X2 | The option is `skipDeploymentUrlCheck`, not `skipConvexDeploymentUrlCheck` | rule 5; the same name the clients already take (STUDY-26 C1) | accepted (owner, 2026-10-03): DV-03 |
| X3 | Imported from `@bunvex/nextjs` (and `Preloaded` / `usePreloadedQuery` from `@bunvex/react`), not a `/nextjs` subpath of one package | the clients are already scoped packages (`@bunvex/client`, `@bunvex/react`); the `bunvex` package does not re-export them yet (ARCHITECTURE.md plans `bunvex/react` and `bunvex/nextjs`) | accepted (owner, 2026-10-03): DV-241 |

The thrown and logged messages keep Convex's structure with bunvex's words (rule 5): "Function called with invalid
deployment address." for Convex's "Convex function called with …".

## 5. Tests

- `@bunvex/nextjs` against a real server (`createServer`, as the client tests do):
  - `fetchQuery` / `fetchMutation` / `fetchAction` with and without arguments; a function error rejects with its
    `BunvexError` data;
  - every request carries `cache: "no-store"` (an injected `fetch` records the init);
  - `token` reaches `ctx.auth`; `adminToken` sends the admin header;
  - the URL: the env default, `url` over it, the "not set" and "invalid deployment address" errors, the warning
    for an explicit `url: undefined`, `validateDeploymentUrl` and `skipDeploymentUrlCheck`;
  - `preloadQuery`'s payload: `_name`, and `_argsJSON` / `_valueJSON` as JSON values (an Int64 and bytes round
    trip), `{}` for no arguments; `preloadedQueryResult` decodes it.
- `usePreloadedQuery` (react tests): the first render is the preloaded value with no `undefined`; it then
  follows the live value after a mutation; a server error throws.
- Sabotage: drop `cache: "no-store"`, return `result` without the fallback.

## 6. Open questions

None.

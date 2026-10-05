# STUDY-99 — `BunvexHttpClient.function()`

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-04
- **Related:** [STUDY-26](STUDY-26-sync-client.md) H3 (the HTTP client), [STUDY-67](STUDY-67-http-function-api.md)
  H5 (`/api/function` on the server), [STUDY-62](STUDY-62-components.md) (components)

## 1. How Convex does it

`npm-packages/convex/src/browser/http_client.ts` has
`function(anyFunction, componentPath?, ...args)`, marked `@internal`. It runs a query, mutation or action by
reference or by name:

- **The request:** `POST /api/function` with the body
  `{componentPath, path, format: "convex_encoded_json", args: convexToJson(args)}`.
  - The arguments are the object itself, unlike `query`, `mutation` and `action`, which send `[args]`.
  - An omitted `componentPath` leaves the JSON field out.
- **The rest:** the same headers, response handling, errors and `BunvexError`-style data as the other calls.
  - Log lines are printed with the `any` source.
  - A mutation does not wait in the mutation queue.

The server side is `execute_any_function` (`crates/local_backend/src/public_api.rs`):

- It runs the function as its own kind, internal functions included.
- It requires an admin key (`must_be_admin`); otherwise it answers 401 `BadDeployKey`.

## 2. What an app can observe

The method is `@internal`, so it is missing from the published types. Tooling that sets an admin key
(`setAdminAuth`) can call any function, internal ones included.

## 3. How bunvex does it

`BunvexHttpClient.function()` in `@bunvex/client` `http-client.ts`. It goes through the same `call` path as
`query` and `action`, so headers, errors and logs are shared, with the object arguments and the `any` log
source as above.

The server route was already Convex's (STUDY-67 H5):

- an admin only;
- the function's own kind;
- a non-empty `componentPath` fails with an internal error, as Convex fails a component path it cannot
  find. bunvex has no components yet (STUDY-62).

## 4. Divergences

None new. The request uses bunvex's format name (`encoded_json`, DV-307) and admin scheme
(`Authorization: Bunvex <key>`, DV-97), as every call of the client does.

## 5. Tests

`packages/sync-e2e/test/http-client.test.ts` runs against a real server:

- With an admin key, `function()` runs:
  - a mutation, by reference and by name;
  - a query;
  - an action with an int64;
  - an **internal** mutation.
- The request is checked: `/api/function`, the arguments not wrapped, `componentPath` sent when given.
- A function's `BunvexError` comes back with its data.
- Without an admin key, the call fails with the server's `BadDeployKey`.
- **Oracle:** Convex's own `ConvexHttpClient.function()` gets the same answers from bunvex, with its format
  name and admin scheme renamed on the wire.

Sabotage checks, each caught:

- the arguments wrapped in an array;
- the wrong endpoint;
- `componentPath` dropped.

## 6. Open questions

None.

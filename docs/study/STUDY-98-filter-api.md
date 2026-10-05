# STUDY-98 — `filterApi`

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-04
- **Related:** [STUDY-36](STUDY-36-codegen.md) (`ApiFromModules`, `FilterApi`)

## 1. How Convex does it

`npm-packages/convex/src/server/api.ts` defines
`filterApi<API, Predicate>(api: API): FilterApi<API, Predicate>`, marked `@public`. It returns its argument
unchanged, and only its type is filtered: `FilterApi` keeps the references matching `Predicate` and drops
empty modules.

`convex/server` exports it (`server/index.ts`). Next to it, `api.ts` has `justInternal`, `justPublic`,
`justQueries`, `justMutations`, `justActions`, `justPaginatedQueries` and `justSchedulable`, the same with
fixed predicates. They are marked `@public` too, but `server/index.ts` does not export them, so an app cannot
import them.

## 2. What an app can observe

- `import { filterApi } from "convex/server"`.
- The result is the same object, so `filterApi(api) === api`.
- Its type keeps only the matching references.

## 3. How bunvex does it

`filterApi` is in `@bunvex/server` `api-types.ts`, next to the `FilterApi` type it returns. It is exported by
the package index and by the isomorphic entry, so it works in a browser or Node bundle as well as in Bun.

## 4. Divergences

None.

## 5. Tests

`packages/server/test/types/functions.test.ts`:

- At runtime, `filterApi(api)` is `api`.
- For `tsc`, `filterApi<PublicApi, FunctionReference<"query">>` keeps the queries (`list`, `count`), drops a
  module with none (`dir`), and refuses a mutation (`@ts-expect-error`).
- `isomorphic.test.ts` checks the browser entry exports it too.

Sabotage checks, each caught:

- a copy returned instead of the argument: the runtime test fails;
- the return type unfiltered (`API`): `tsc` fails (the `@ts-expect-error` and the key checks).

## 6. Open questions

None.

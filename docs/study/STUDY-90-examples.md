# STUDY-90 — Examples, demos and templates

- **Status:** first batch built (eight examples); templates and a public mirror later. `examples/` at the root
  (owner, 2026-10-04)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend (`npm-packages/demos`,
  `npm-packages/private-demos`); github.com/get-convex/templates and github.com/get-convex/convex-demos
  (2026-10-04)
- **Related:** [STUDY-35](STUDY-35-push-and-deploy.md), [STUDY-36](STUDY-36-codegen.md) and
  [STUDY-38](STUDY-38-docker.md) (each planned "an example app end to end"), [STUDY-40](STUDY-40-local-backend-and-local-deployments.md)
  (the npm names).

## 1. How Convex does it

Three different things, all public:

- **Demos** (35): one small app per feature, sources in the monorepo's `npm-packages/demos`, "synced to the
  convex-demos repo during NPM release" (`demos/README.md`; github.com/get-convex/convex-demos). Each is a Vite +
  React or Next.js app with a `convex/` directory, its committed `convex/_generated/`, and the scripts `dev`
  (`convex dev --start 'vite --open'`) and `build` (`tsc` + the bundler). Nothing in the public workflows runs
  them; they are documentation that compiles.
- **Templates** (~25): starting points for `npm create convex@latest [-t <template>]`, in
  github.com/get-convex/templates (it holds `create-convex` too; the older `create-convex` and `template-*`
  repositories are deprecated): `bare`, `react-vite`, `nextjs`, `tanstack-start`, `astro`, `component`, with
  `-clerk`, `-convexauth`, `-authkit` and `-shadcn` variants.
- **Private demos** (~50, `npm-packages/private-demos`): internal test apps (`pagination-adversarial`, `e2e`,
  `static-codegen`, `tanstack-start`, …), not for users.

Also `convex-tutorial` / `convex-tour-chat` (the site's tutorial app) and `convex-helpers`, a library some demos
depend on.

## 2. What users observe

A runnable app per feature, in a public place, that builds against the released packages; a one-line way to
start a project from a template.

## 3. How bunvex does it

**`examples/` at the repository's root**, a workspace glob of its own. Not `apps/`: those are bunvex's own
products (dashboard, site) under their own dependency rules; an example is a user's app and may import only the
public packages (`bunvex`, `bunvex/*`, `@bunvex/*` clients), which `check-deps` enforces for `examples/*`. The
directory can become a public mirror's root as it is.

Each example:

- is written from scratch for bunvex, after the scenario of the Convex demo of the same name (never its code);
- has `bunvex/` (functions, schema, committed `_generated/`), a Vite + React (or Next.js) front end, `README.md`
  and `package.json` with `dev` (`bunvex dev --start …`) and `build`;
- has an end-to-end test, run in CI: the backend as `bunvex-local-backend` (run by Bun), an admin key from
  `keygen`, `bunvex deploy` (bundle, push, codegen), then the functions through the public client, and the
  front end's typecheck and build. The test also checks the committed `_generated/` is what codegen writes.

That makes the examples the proof that the product works together (CLI, push, codegen, server, clients, React,
Next.js), which Convex's demos are not. The examples' tests run in their own CI job, on every PR, next to the
unit tests (`bun run test:examples`, with a 120 s timeout per test: each deploys a backend); the root `bun test` ignores `examples/**`.

### Which demos, and when

| Demo | bunvex | |
|---|---|---|
| `tutorial` | **built** (`examples/tutorial`) | a query and a mutation; the test follows the list live, the 50-message window and argument validation |
| `pagination` | **built** (`examples/pagination`) | `usePaginatedQuery`; the test follows `onPaginatedUpdate_experimental` through `loadMore` and a live insert, an index with an argument, a reshaped page |
| `search` | **built** (`examples/search`) | a `searchIndex`; the test checks relevance and a new match joining the results live |
| `file-storage` | **built** (`examples/file-storage`) | upload URL → POST → `sendImage`; the test reads the same bytes and content type back from `getUrl`'s URL |
| `react-query` | **built** (`examples/react-query`) | `@bunvex/react-query`; the test prefetches and dehydrates on the server path, and follows the list live |
| `scheduling` | **built** (`examples/scheduling`) | a countdown of `runAfter` steps in an internal mutation, followed live |
| `cron-jobs` | **built** (`examples/cron-jobs`) | a 10-second `crons.interval` clearing the messages; the test waits for it |
| `nextjs-app-router` | **built** (`examples/nextjs-app-router`) | `preloadQuery` in a Server Component, `usePreloadedQuery` live, a Server Action; `next build` in the test (Next 16.3.8, `transpilePackages`) |
| `typescript`, `args-validation`, `custom-errors`, `relational-data-modeling`, `system-tables`, `vector-search`, `file-storage-with-http`, `http`, `prewarming`, `nextjs-pages-router`, `users-and-clerk`, `giphy-action`, `dall-e-storage-action` | later batches | ready; the last two need an API key (their test stubs the external call) |
| `node` | waits | Node actions (`"use node"`) |
| `python-quickstart` | waits | a Python client |
| `zod-validation-ts`, `sessions`, `presence-facepile`, `presence-typing-indicator` | waits | `convex-helpers` or components |
| `html` | waits | a browser bundle of the client for `<script>` |
| `convex-test` | waits | `@bunvex/testing` |
| `users-and-auth`, `clerk`, `users-and-clerk-webhooks`, `react-native`, `tour-chat`, `giphy`… | later batches | to check one by one |

**Templates** (`bun create bunvex`): a second step, once the first examples are in; each template is close to
a lean example, and they are worth most once the packages are published (STUDY-40: `@bunvex/*` today, `bunvex`
pending npm).

### What the first batch found

Two bunvex bugs no unit test had caught, each fixed in its own PR:

- **`bunvex/server` did not load outside Bun** (STUDY-91, #382): every front end importing `_generated/api`
  failed to bundle (Vite, webpack) or to load in Node (Next.js). Found by the tutorial's first `vite build`.
- **`@bunvex/file-storage`'s `env` parameters were typed `NodeJS.ProcessEnv`** (#383), which Next.js's types make
  stricter: `next build`'s typecheck failed in any Next.js app. Found by `nextjs-app-router`.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| E1 | `examples/` lives in the main repository, and its apps run end to end in CI; a public mirror comes later | Convex syncs `demos/` to `convex-demos` on release and only builds them | accepted (owner, 2026-10-04) |
| E2 | Examples are bunvex's own code after Convex's scenarios, with bunvex's names (`bunvex/` functions directory, `bunvex/*` imports) | rule 5; never copy Convex's code | accepted (owner, 2026-10-04) |

Neither changes how an app behaves; they are recorded here, not in the divergences ledger.

## 5. Tests

Each example's `test/e2e.test.ts`, by the shared helper `examples/e2e.ts`: deploy, then the scenario through
`BunvexClient` / `BunvexHttpClient` (live updates where the demo shows them), the `_generated/` check, and the
front end's `tsc` and build. Sabotage: break a function, and its example's test fails.

## 6. Open questions

The template command's name and the mirror repository's name, when they come.

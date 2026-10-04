# STUDY-91 — `bunvex/server` outside Bun: the browser and Node, as `convex/server`

- **Status:** implemented; no divergence (owner, 2026-10-04: full parity with Convex rather than a smaller entry)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend (`npm-packages/convex/package.json`,
  `src/server/index.ts`, `src/server/impl/syscall.ts`, `src/server/components/index.ts`)
- **Related:** [STUDY-90](STUDY-90-examples.md) (the first example found it), [STUDY-36](STUDY-36-codegen.md)
  (`_generated/`), [STUDY-66](STUDY-66-registration.md) §7 (`assertNotBrowser`).

## 1. How Convex does it

`convex/server` is one module for every runtime: the function builders, `defineSchema`, function references
(`anyApi`, `makeFunctionReference`), validators, `httpRouter`, `cronJobs`, `createFunctionHandle`. None of it
needs the backend: the builders only describe a function, and anything that needs a running backend goes
through a syscall, which throws outside one ("The Convex database and auth objects are being used outside of a
Convex backend. Did you mean to use `useQuery` or `useMutation` to call a Convex function?",
`impl/syscall.ts`). So an app's front end imports `_generated/api` (which imports `anyApi` from `convex/server`)
in a browser bundle, and a Next.js Server Component does so in Node.

## 2. What an app observes

`import { api } from "../convex/_generated/api"` in front-end code builds with Vite, webpack or Next.js; code
shared between functions and the front end (validators, a schema, constants beside a `query`) loads in both;
`createFunctionHandle` called outside a function throws the message above.

## 3. How bunvex did it, and how it does it now

`@bunvex/server` is both the app's API and the runtime (the engine, persistence, `createServer`): its index
imports `bun:sqlite`, `bun` (S3) and `node:crypto`'s `timingSafeEqual`. So `bunvex/server` — and every
`_generated/api` — failed to bundle for a browser, and failed to load in Node. Nothing caught it: no web app
was built in the repository until the examples.

Now:

- **The builders** (`query` … `internalActionGeneric`, `FunctionDef`, `isFunctionDef`) moved from
  `functions.ts` to `builders.ts`, which imports no runtime; `functions.ts` re-exports them unchanged.
- **`@bunvex/core/schema`** exports `src/schema.ts` (`defineSchema`, `defineTable`, `docValidator`), which
  bundles alone; `@bunvex/core`'s index still has the engine.
- **`src/isomorphic.ts`**: every value `index.ts` exports except the runtime's (admin keys, `Functions`,
  `createServer`, persistence, the local backend, `ScheduledJobExecutor`: names `convex/server` does not have),
  the same objects, plus every type. `createFunctionHandle` there checks the reference and throws bunvex's
  wording of Convex's message.
- **`package.json`**: `"."` is `{ types: index.ts, bun: index.ts, default: isomorphic.ts }`. Bun (the backend,
  the CLI, tests) gets the whole package with no import changed anywhere; a browser bundler and Node get the
  isomorphic entry; TypeScript sees the whole package's types.

## 4. Divergences

None: every name Convex's module has is present everywhere and behaves the same. The runtime-only names exist
only under Bun, and Convex has no such names.

## 5. Tests

`packages/server/test/isomorphic.test.ts`: the isomorphic entry's values are exactly the package's minus the
runtime list (a new export fails it until it is classified), the same objects; it bundles for a browser with no
`bun:sqlite`, `createServer` or `node:async_hooks` in the output; `createFunctionHandle` throws outside a
backend; a builder and a schema made through it work. End to end: every example's front-end build
(STUDY-90). Sabotage: dropping `cronJobs` from the entry, and importing the runtime into it, each fail.

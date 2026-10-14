# STUDY-160 — The packages as npm ships them: compiled JavaScript for Node.js and the bundlers

- **Status:** implemented (#633); DV-503 accepted, DV-504 matched to Convex (owner, 2026-10-14)
- **Convex source read:** `npm-packages/convex` at the commit of [STUDY-137](STUDY-137-convex-reference-2026-10-07.md)
- **Related:** [STUDY-40](STUDY-40-local-backend-and-local-deployments.md) §1.3 and L7 (the npm packages),
  [STUDY-36](STUDY-36-codegen.md) G5 (DV-177), [STUDY-91](STUDY-91-isomorphic-server.md) (`@bunvex/server`
  outside Bun), [STUDY-151](STUDY-151-small-parity-batch.md) §5 (the WebSocket on Node), ARCH-01 D8

The owner decided on 2026-10-13 that bunvex's client must run on Node.js as Convex's does. Until now the
`@bunvex/*` packages shipped only their TypeScript sources: Bun runs them from `node_modules`, Node refuses them
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and a framework had to transpile them (`transpilePackages` in
Next.js). STUDY-40 left "the built package (JS and `.d.ts`)" as a roadmap item; this is it.

## 1. How Convex does it

`npm-packages/convex/package.json` and `scripts/build.py`:

- **One package, built to `dist/`:** ES modules (`dist/esm`) and CommonJS (`dist/cjs`), each with its declarations
  (`dist/esm-types`, `dist/cjs-types`, plus `internal-*-types` behind a private condition). tsc emits the
  declarations; esbuild compiles each file on its own (no bundling of the library).
- **`exports`:** every subpath (`.`, `./server`, `./react`, `./react-auth0`, `./react-clerk`, `./nextjs`,
  `./browser`, `./values`, `./package.json`) has a `require` branch (`types`, `require`) and an `import` branch
  (`types`, `import`). `main`, `module` and `types` point at `dist/` too, for older resolvers.
- **`files`:** `dist`, `src` (the TypeScript sources ship too, for source maps), the subpath directories and a
  UMD `browser-bundle.js` for `<script>` tags. `engines`: `node >= 20`.
- **Releasing:** `prepack` checks the version and builds; `postpack` strips the internal types.
- **On Node:** the sync client takes `ws` in its Node entry (`browser/simple_client-node.ts`); Node 22 and later
  also have a global `WebSocket`.

## 2. What an app can observe

1. `node app.mjs` with `import { ConvexHttpClient } from "convex/browser"` works, and so does `require`.
2. A bundler (webpack, Vite, Turbopack, esbuild) takes the package without being told to transpile it.
3. TypeScript reads `.d.ts` files: no `allowImportingTsExtensions`, any `moduleResolution` (`node16`/`nodenext`,
   `bundler`, `node10` through `types`).
4. The package's size: compiled code, declarations and sources.

## 3. How bunvex does it

**Built at release, not in the workspace.** The repository's `package.json` files keep exporting the sources, so
the monorepo, its tests, its examples and every session's work need no build step (the private workspace
packages, `@bunvex/dashboard-source` among them, import the sources as before). `scripts/npm-packages.ts` writes
each package as npm gets it, and `scripts/publish-npm.ts` packs those staged copies (it used to pack the package
directories):

- **`dist/esm` and `dist/cjs`:** each source file compiled on its own (`ts.transpileModule`, ES2022, the sources
  being isolated modules), relative `.ts` specifiers rewritten to `.js`, and `dist/cjs/package.json` saying
  `commonjs`. A specifier that leaves `src/` (`../package.json`, the client's version) points at the same file
  from `dist/`.
- **Declarations:** one TypeScript program over every built package emits the `.d.ts` files, copied beside both
  outputs (`dist/esm/*.d.ts` for `import`, `dist/cjs/*.d.ts` for `require`).
- **`exports`:** each subpath becomes `{ bun: <source>, import: { types, default }, require: { types, default } }`,
  plus `./package.json`; `main`, `module` and `types` as Convex's. `@bunvex/server` keeps its split (STUDY-91): Bun
  gets `src/index.ts`, everyone else `dist/*/isomorphic.js`, with the types of `index`.
- **Internal versions:** `workspace:*` becomes the release's version in the staged `package.json`.
- **`files`:** `dist`, `src` (without tests), `README.md`, `LICENSE`.

Built: `values`, `search`, `protocol`, `core`, `auth`, `file-storage`, `persistence`, `server`, `client`, `react`,
`react-clerk`, `react-auth0`, `react-query`, `nextjs`. Not built: `cli`, a Bun program (`bunx bunvex`, STUDY-40 L7)
that no app imports.

**Source changes** for declarations that stand alone:
- `@bunvex/core` exports the type `DiscardedStagedValidator` (part of `SchemaPrediction`, which it already
  exported): without it the declaration of `@bunvex/server`'s push cannot name it.
- `@bunvex/values`'s `omit`, `pick`, `partial` and `extend` write their return types out. The declaration emit
  inlined `ObjectType<…>` into mapped types that do not typecheck on their own (an app with `skipLibCheck` off
  saw TS2536 and TS2344 in `validators.d.ts`).
- `@bunvex/server` declares the members of Bun's `Server` and `ServerWebSocket` its API exposes
  (`bun-types.ts`: `BunServer` for `createServer`'s `server` and `site`, `BunServerWebSocket` for a sync session's
  socket), so its declarations name nothing of Bun's (DV-504, owner 2026-10-14: as Convex's). Bun's objects have
  every member; the repository's typecheck checks that where they are assigned.
- `@bunvex/core`'s `BTree` type names `sorted-btree`'s class as the module's `default` (`import type * as`): its
  default import is the class to a bundler but the whole `module.exports` to Node's ES modules, where the
  declaration failed with TS2709.

**The test** (`packages/sync-e2e/node/npm-packages.node.ts`, `bun run test:npm`, its own CI job with Node 22):
stages the packages into an app's `node_modules`, then
- `node esm.mjs`: the HTTP client (query, mutation, action with an int64, a `BunvexError` with its data),
  `fetchQuery` from `@bunvex/nextjs`, the sync client's live query over Node's `WebSocket`, `defineSchema`, and the
  React packages loaded;
- `node cjs.cjs`: the same through `require`;
- `tsc` over a typed file with `nodenext` (an ES module and a `.cts`) and with `bundler`, `skipLibCheck` on as the
  frameworks set it, and again with it off, with Node's types and no Bun types (both resolutions): zero errors.
  `@ts-expect-error` lines prove the types are the declarations', not `any`.

Before this change (each package staged as sources only, as published until now) both `node` runs fail with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Sabotage: without `esModuleInterop` the CommonJS run fails (the
version is `undefined`); without the `../package.json` relocation both fail; reverting a source change fails
staging (core's export) or the strict typecheck (values: TS2536; `site` or the socket typed as Bun's: TS2503 or
TS2307; the `BTree` type: TS2709).

**Measured** (Apple M-series, warm): staging all fifteen packages takes 5.4–5.8 s (the declarations' program is
most of it). The packed size grows with `dist/` (gzip, all fifteen): 1.09 MB → 3.37 MB; `@bunvex/client` 40 kB →
118 kB, `@bunvex/values` 36 kB → 110 kB, `@bunvex/react` 22 kB → 60 kB, `@bunvex/server` 0.46 MB → 1.65 MB.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-503 | Under Bun, the packages run from their TypeScript sources (the `bun` condition, first in `exports`); Node, the bundlers and TypeScript get `dist/`. Convex has no Bun branch: Bun loads its `dist/esm`. Not observable but for file names in stack traces (`src/…ts` instead of `dist/esm/…js`) | The server and the CLI are Bun programs tested only from their sources (pushed code's realm, `import.meta` uses, the CLI's bundling); keeping Bun on the sources keeps what runs there unchanged. Alternative: Bun on `dist/esm` as Convex, after running the server's suites against the build | accepted (owner, 2026-10-14: A) |
| DV-504 | `@bunvex/server`'s declarations name Bun's types (`Server`, `ServerWebSocket` from `bun`): an app with `skipLibCheck: false` and no `@types/bun` gets two errors in them. Convex's need nothing beyond its own | The server's public API is Bun's (`createServer` returns Bun's server). `skipLibCheck` is on in `bunvex codegen --init`'s tsconfig, Next.js's and Vite's templates, as in Convex's. Alternative: declare those types structurally in the server so its declarations stand alone | matched to Convex (owner, 2026-10-14: B): the server declares what it uses (`bun-types.ts`) |

Not done, recorded in the parity inventory: Convex's UMD `browser-bundle.js` (a `<script>` tag build of
`convex/browser`); `engines.node` (the sync client needs Node 22's `WebSocket` unless one is passed, decided in
STUDY-151 §5). Follow-up once a built release is on npm: `codegen --init` can stop writing
`allowImportingTsExtensions` for apps on the published packages (DV-177), and the Next.js example's
`transpilePackages` is then only for the workspace.

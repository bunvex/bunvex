# STUDY-83 — Bundling `server-only` and `.wasm` imports

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-04
- **Related:** [STUDY-35](STUDY-35-push-and-deploy.md) (bundling and pushing)

## 1. How Convex does it

`npm-packages/convex/src/bundler/index.ts:104-107` runs esbuild with `[serverOnlyPlugin, external.plugin,
wasmPlugin]`. `serverOnlyPlugin` comes first, so `server-only` is stubbed even when it is listed as an
external package. `wasmPlugin` comes last, so it never runs on external modules. The schema is bundled with
the same plugins.

- **`serverOnly.ts`** (commit 37744080c, "support import \"server-only\""):
  - `onResolve(/^server-only$/)` sends the import to the `server-only-stub` namespace, whose `onLoad` returns
    an empty JS module.
  - This applies whether or not the package is installed. The real `server-only` package's default entry
    throws ("This module cannot be imported from a Client Component module…"), so a Next.js app's shared
    code that guards itself with `import "server-only"` would otherwise fail to bundle (not installed) or
    fail at import (installed).
- **`wasm.ts`**:
  - A `.wasm` import resolves (relative to the importer) to a `wasm-stub` module:
    `import wasm from "<path>"; export default new WebAssembly.Module(wasm)`.
  - The stub's own import loads the file with esbuild's `binary` loader (the bytes inlined as base64, decoded
    to a `Uint8Array`).
  - So `import m from "./x.wasm"` gives a compiled `WebAssembly.Module`, which the function instantiates.
- **Metafile paths.** Inputs in the stub namespaces are skipped when checking whether files changed during
  bundling (`index.ts:113-120`).

## 2. What an app can observe

1. A module, or anything it imports, may `import "server-only"`. The push bundles it and the function runs,
   whether the package is installed or not.
2. `import m from "./x.wasm"` gives a `WebAssembly.Module` built from the file's bytes, which the push
   carries (no separate file).

## 3. How bunvex does it

`packages/cli/src/bundle.ts` runs two Bun plugins, in Convex's order, for the functions' bundles (isolate and
`"use node"`) and for `schema.js` / `auth.config.js`:

- `bunvex-server-only` is the same resolve-to-empty stub.
- `bunvex-wasm` resolves `.wasm` imports (relative to the importer) to a stub module. The stub inlines the
  file's bytes as base64, decodes them into a `Uint8Array`, and exports `new WebAssembly.Module(bytes)`. The
  result is what esbuild's binary loader produces, so the bundle's size is the same.
- bunvex has no external packages yet (`node.externalPackages` is a separate gap), so "wasm after external"
  has nothing to skip.

This runs at bundle time only, so it adds no runtime cost.

## 4. Divergences

None.

## 5. Tests

In `packages/cli/test/deploy.test.ts`, an app with three modules is bundled and deployed to a real server:

- a module that imports `server-only` and a helper that also imports it, with a fake installed `server-only`
  package that throws;
- a module that imports `./add.wasm`, a 41-byte module exporting `add`.

The checks: the bundle does not contain the throwing package; the guarded query answers; the import is a
`WebAssembly.Module`; and `add(2, 40)` returns 42.

Sabotage checks: without the `server-only` plugin the bundle contains the throwing package; without the
`.wasm` plugin the query does not get a module. Each fails the test.

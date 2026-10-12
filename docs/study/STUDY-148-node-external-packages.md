# STUDY-148 — `node.externalPackages`: packages installed by the deployment for Node actions

- **Status:** decided (owner, 2026-10-12): Q1–Q4 as recommended (DV-470–DV-473); Q5–Q7 match Convex and stand as
  designed. PR 1 (the `bunvex.json` check, #587), PR 2 (`require` in `"use node"` modules, #588), the import-time
  variables fix found on the way (#589) and PR 3 (the feature, #590) implemented.
- **Convex source read:** the reference `d8bdde0` (`precompiled-2026-10-07-d8bdde0`, `docs/parity/upstream.md`),
  lines below at that commit (`bundler/external.ts`, `crates/model/src/external_packages/*`,
  `npm-packages/node-executor/src/{build_deps,source_package}.ts` are unchanged since the local clone's `4577b90`;
  `bundler/index.ts` and `components/definition/bundle.ts` moved by a few lines). The CLI's behaviour checked with
  the `convex` 1.46.0 CLI and the backend checked with the `precompiled-2026-10-07-d8bdde0` local backend, against a
  local npm registry (§5).
- **Related:** [STUDY-145](STUDY-145-project-config-keys.md) (the other `convex.json` keys; left this one out),
  [STUDY-83](STUDY-83-bundling-server-only-and-wasm.md) (Convex's bundler plugins: `server-only`, then external, then
  wasm), [STUDY-35](STUDY-35-push-and-deploy.md) (push, DV-164/DV-169: `"use node"` in the server's process),
  [STUDY-134](STUDY-134-system-row-shapes.md) (`_source_packages.externalPackageId`), DV-87 (Node actions run in
  Bun), DV-170 (`bunvex.json`)

The platform row "`node.externalPackages` (installed server-side, `_external_deps_packages`)", item 3 of the parity
README's gaps by impact: Node actions whose dependencies cannot be bundled (native addons, packages that read their
own files next to them, binaries they spawn).

## 1. How Convex does it

### 1.1 The setting (`npm-packages/convex/src/cli/lib/config.ts`)

`NodeSchema` (`:266-277`): `externalPackages` is an array of strings, default `[]`, described as "list of npm packages
to install at deploy time instead of bundling. Packages with binaries should be added here."; then `nodeVersion`. zod's
first issue is printed as ``` `<path>` in `convex.json`: <message> ``` (STUDY-145), an element naming its index. From
the 1.46.0 CLI:

| `convex.json` | message |
|---|---|
| `{"node":{"externalPackages":"x"}}` (`null`, `{}`) | `` `node.externalPackages` in `convex.json`: Expected array, received string `` (`null`, `object`) |
| `{"node":{"externalPackages":[1]}}` (`[null]`, `[[]]`) | `` `node.externalPackages.0` in `convex.json`: Expected string, received number `` (`null`, `array`) |
| `{"node":{"externalPackages":["a",{}]}}` | `` `node.externalPackages.1` in `convex.json`: Expected string, received object `` |
| `{"node":{"nodeVersion":1,"externalPackages":"x"}}` | the `externalPackages` one (it comes first in `NodeSchema`) |
| `{"functions":1,"node":{"externalPackages":1}}` | the `functions` one |

`"*"` is an ordinary element (§1.2).

### 1.2 What the CLI leaves external (`npm-packages/convex/src/bundler/external.ts`, `bundler/index.ts`)

Only the `"use node"` bundle reads the list: `bundle()` is called with `externalPackagesAllowList` for the Node
entry points only (`config.ts:657`, `components/definition/bundle.ts:731`); the isolate bundle has none, and would
crash with "external dependencies not supported" if it found any (`bundle.ts:708`). An isolate file importing a
listed package bundles it (and fails if it needs Node builtins: checked).

1. `computeExternalPackages` (`external.ts:106-177`): with an empty list, nothing. Otherwise it finds the project's
   `package.json` (`findParentConfigs`: the first `package.json` from the working directory up; none is "No
   package.json found. To create a new project using Convex, see …"), parses it ("Couldn't parse "<path>". Make sure
   it's a valid JSON. Error: <error>"), and walks `dependencies`, `devDependencies`, `peerDependencies`,
   `optionalDependencies` in that order, the first occurrence of a name winning. A version that is not a string is
   `Invalid "<path>". "<key>.<name>" version has type <type>.` A name is a candidate when `shouldMarkExternal`
   (`:179-213`) says so:
   - never `convex` ("Always bundle convex");
   - never a `file:` or `git+file://` version, nor `http://`, `https://`, `git://`, `git+ssh://`, `git+http://`,
     `git+https://` ones (bundled: "Installing those might or might not work");
   - otherwise when the list names it, or holds `"*"`.

   A candidate is kept only if `<dir of package.json>/node_modules/<name>` exists (scoped names as two directories).
2. The esbuild plugin `convex-node-externals` (`createExternalPlugin`, `:59-103`) runs between `serverOnlyPlugin` and
   `wasmPlugin` (`index.ts:107`): for every non-relative import it takes the package name (`@scope/name` or the first
   segment), and if that is a candidate it walks up from the importer's directory to the first
   `node_modules/<name>` that exists (`resolveNodeModule`); only if that is the candidate's own path (the project's
   top-level copy) is the import left external, as written (`tiny-asset/index.js` stays `tiny-asset/index.js`), and
   the name recorded as used. Anything else is bundled. A package that is not installed is esbuild's "Could not
   resolve" error (the plugin does not change that).
3. `externalPackageVersions` (`index.ts:276-310`): for each package the bundle used, the version is read from its
   installed `package.json` (`findExactVersionAndDependencies`, `external.ts:215-265`): the exact installed version,
   not the range in the app's `package.json` ("Since we don't support lock files … we pick up the exact version
   installed"). A missing or unparsable `package.json` there, or one without `version`, fails ("Missing "<path>",
   which is required for installing external package "<name>" configured in convex.json." / ""<path>" misses a
   'version' field. which is required for …"). The package's `peerDependencies` and `optionalDependencies` that are
   also candidates are added, transitively. Packages listed but never imported by a `"use node"` file are not sent.

The push request carries them as `nodeDependencies: [{name, version}]` (`components.ts:447`; `startPush.ts`:
required, possibly empty). With `--verbose`, the CLI prints "Node.js runtime external dependencies (to be installed on
the server): " and `name: version` lines. Components may not use `"use node"` at all.

What the bundle looks like (checked): `import { read, where } from "tiny-asset";` in `ext.js`, unbundled; a
`require("tiny-asset")` stays a `__require("tiny-asset")` call (esbuild's shim, which reaches Node's `require`).

### 1.3 What the deployment does with them

**Building** (`crates/application/src/lib.rs`): `upload_packages` (`:2335`), the first step of `start_push` (also
for a dry run and for `evaluate_push`), calls `build_external_node_deps` (`:2885-2920`) when the list is not empty:

1. **Cache:** `ExternalPackagesModel::get_cached_package_match` (`crates/model/src/external_packages/mod.rs:84-122`)
   reads the newest `_external_deps_packages` rows by creation time, at most 10
   (`NUM_EXTERNAL_DEPS_CACHE_ENTRIES`), and reuses the first whose deps, as a map from package to version, equal the
   push's. A hit installs nothing (checked: a second push makes no registry request and reuses the row's id).
2. **Install** (`application_function_runner/mod.rs:1685-1707` → the Node executor's `build_deps`,
   `npm-packages/node-executor/src/build_deps.ts`): a fresh `<tmpdir>/build_deps` directory; a `package.json` with the
   deps as `dependencies` (name = the upload URL, version `0.0.0`); `execSync("npm install")` there (`:128`); the
   resulting `node_modules` zipped by `archiver` as `node_modules/…` entries, directory entries and Unix modes included
   (`:139`); the zip's sha256, its size and the sum of the files' sizes (`dirSize`) returned; the zip written to the
   modules storage under a fresh key (the local backend's storage is a `file:` URL). On the cloud the npm cache is
   moved into the build directory (Lambda's read-only home); locally npm runs with the backend's environment, so its
   registry, `.npmrc` and script settings apply.
3. **Failure:** the executor's error becomes a 400 `InvalidExternalModules`, "Loading the pushed modules encountered
   the following error:\n<message>" (`:2905-2915`); the CLI prints it under "Hit an error while pushing:". The message
   is `execSync`'s: `Command failed: npm install` and npm's stderr (checked: `npm error code ETARGET` / `npm error
   notarget No matching version found for tiny-asset@9.9.9…` from a registry without that version).
4. **Row:** `_external_deps_packages` (`EXTERNAL_PACKAGES_TABLE`, `mod.rs:36`, table number 537) gets
   `SerializedExternalDepsPackage` (`types.rs:60-68`), in its own commit:
   `{storageKey, sha256: bytes, deps: [{package, version}], packageSize: {zippedSizeBytes, unzippedSizeBytes}}` (int64
   sizes). Note `package` here, `name` on the wire (`NodeDependencyJson`, `deploy_config.rs:1641`).
5. **Size:** the deps package's sizes are added to the app's and the components' packages, and the total is checked
   against the package limits (`lib.rs:2476`, `PackageSize::verify_size`: `MAX_ZIPPED_PACKAGES_SIZE`, 90 MB by
   default, and 230 000 000 bytes unzipped), Convex's 400 `ModulesTooLarge` "Total module size exceeded the …
   maximum".
6. **Links:** the push's source package records the deps: `_source_packages.externalPackageId` is the row's id
   (`source_packages/types.rs:258`), and the package's `metadata.json` has `externalDepsStorageKey`
   (`upload_download.rs:71-126`). `start_push` answers `externalDepsId` (`deploy_config2.rs:175`); `finish_push`
   gets it back.

Nothing ever deletes `_external_deps_packages` rows or their blobs (`ExternalPackagesModel` has no delete; they are
the cache's entries).

**Loading** (`npm-packages/node-executor/src/source_package.ts`): to run or analyze a Node module, the executor
downloads the source package and, if it has one, the deps package, each once per process, into
`<tmpdir>/source/<key>` and `<tmpdir>/external_deps/<key>` (`:145-172`). The deps zip's sha256 is checked; each entry
must start with `node_modules/` ("found incorrect package entry <name>", `:340`); it is unzipped with AdmZip's
`extractAllTo(dir, true)` (`:324`), which does not keep Unix modes; `<source>/node_modules` is a symlink to the deps'
`node_modules` (`:191`). Node's own resolution then finds the packages from the modules' directory: ESM imports, and
`require`, which the executor sets per invocation to `createRequire(<module path>)` (`executor.ts:73`). A deps
directory no package uses is deleted when another is downloaded (`cleanupExternalPackages`, `:544`). The local
backend runs this executor on the machine's `node` (`crates/node_executor/src/local.rs:163-205`: nvm's version, else
`PATH`), its temporary directory removed when the backend exits.

Measured on the local backend (a `tiny-bin` package whose `bin/run.sh` is 0755 in the zip): the extracted file is
0666 and spawning it fails with `EACCES`; with npm's scripts enabled its `postinstall` ran during the push.

Observed quirk: the local executor saves and restores `process.env` around each invocation by assigning a new
object; after the first Node action, `npm` no longer sees the backend's `npm_config_*` variables (a push that misses
the cache then reaches the public registry). Irrelevant to apps; the oracle tests push before calling actions.

## 2. What an app can observe

- The CLI's `bunvex.json` messages (§1.1).
- Which imports stay external: only `"use node"` files, only top-level packages of the project's `package.json` that
  are listed (or under `"*"`), not `convex`, not local/URL/git versions; their peer and optional dependencies too.
- At push: the deployment installs the exact installed versions; a cache hit reuses the last matching row; a failed
  install is a 400 `InvalidExternalModules` with the installer's output; the total size limit counts the deps.
- `_external_deps_packages` rows and their fields, `_source_packages.externalPackageId`, the package's
  `metadata.json` `externalDepsStorageKey`, `start_push`'s `externalDepsId` (the dashboard's data browser shows
  system tables only for the documented ones; the CLI never prints these ids).
- At run time: the packages load from a real `node_modules` on disk, so `__dirname`, files next to the code and
  native addons work; `require` works; packages see the action's `process.env` (the deployment's variables); executable
  bits are lost.

## 3. How bunvex does it

### 3.1 The CLI (PR 1, PR 3)

- `readProjectConfig` (`packages/cli/src/deploy.ts`) checks `node.externalPackages` as §1.1, in `NodeSchema`'s order
  (PR 1). Until PR 3 the list is accepted and ignored, which is what an app gets on Convex when no listed package is
  imported: everything is bundled.
- PR 3: `packages/cli/src/external.ts` is §1.2 written for Bun: the candidates from the project's `package.json` with
  Convex's rules and messages ("bunvex.json" for "convex.json", DV-170; the "No package.json found." line without
  Convex's docs link, DV-04); a Bun plugin (`bunvex-node-externals`) between `server-only` and `.wasm` in the
  `"use node"` build only (and only when there are candidates), returning `external: true` for imports of a
  candidate that resolve to the project's top-level copy (real paths compared: Bun gives an importer's real
  directory); the versions and peer/optional dependencies read from the installed `package.json` files.
  `bunvex`, `bunvex/*` and `@bunvex/*` are never candidates: they are linked to the server's own modules (DV-168,
  DV-169), bunvex's equivalent of "always bundle convex" (Q5). `bunvex deploy` and `dev` send
  `nodeDependencies: [{name, version}]`.

### 3.2 The deployment (PR 3)

- `start_push` (`packages/server/src/push.ts`), after the Node version check and before anything else, as Convex's
  `upload_packages`, also on a dry run and `evaluate_push`:
  1. `nodeDependencies` must be an array of `{name, version}` strings (serde's error, abridged, as a 400 `BadJsonBody`).
  2. The cache: the 10 newest `_external_deps_packages` rows, a hit when the package→version maps are equal.
  3. Otherwise the install (`packages/server/src/external-deps.ts`): a fresh temporary directory, a `package.json`
     with the deps, `bun install` run with the server's own Bun (`process.execPath`, `BUN_BE_BUN=1` for a compiled
     server) and the server's environment (so `NPM_CONFIG_REGISTRY`, `.npmrc` and `bunfig.toml` apply, as npm's
     settings do on Convex), then `bun pm trust --all` so every dependency's install scripts run, as npm runs them
     (Q1, Q2; with nothing left to trust it says "0 scripts ran" and exits 1, which is not a failure). A failure is
     Convex's 400 `InvalidExternalModules` with `Command failed: bun install` and Bun's output.
  4. `node_modules` zipped as Convex's archive: `node_modules/…` entries, directories included, Unix modes kept; put in
     the modules store (its own key); the row inserted in its own commit with Convex's fields and int64 sizes.
  5. The size check adds the deps' sizes to the package's (`ModulesTooLarge`).
- The installed `node_modules` is moved into the process's deps directory (`<tmpdir>/bunvex-node-<random>/<storage
  key>/node_modules`, created on first use, removed at exit), as the Node executor's per-process directory.
- The version is loaded with that directory: a `"use node"` module's bare import that is not a builtin or a server
  module resolves from it (Bun's resolver, as from a module next to that `node_modules`) and is loaded in the
  server's realm, as builtins are (DV-169), by Bun's `require`, which takes CommonJS and ES modules alike and, unlike
  a dynamic `import()` (measured), runs the package's top level in the caller's async context, so the deployment's
  variables are in scope at its import (Q3); a CommonJS package's namespace is its exports plus `default`, as
  `import` gives it; a package with top-level await is imported instead. `import.meta.require` (Bun's bundle turns
  `require` into it; PR 2) is a `createRequire` from `<that directory>/modules/<module path>`.
- `finish_push` stores `externalPackageId` and `externalDepsStorageKey` with the package; `start_push` answers
  `externalDepsId`.
- At start, a deployable server loading a version whose package has an `externalPackageId` downloads the deps blob,
  checks its sha256, refuses an entry outside `node_modules/` (Convex's message), and extracts it into the deps
  directory, modes and symlinks included.
- Rows and blobs are never deleted (as Convex). `_external_deps_packages` stops being one of the "empty cloud tables"
  (`EMPTY_CLOUD_SYSTEM_TABLES`) in `@bunvex/core` and gets its own constant; its number stays 537.
- Packages see the deployment's variables (Q3, option C): once a version with packages loads, the server's
  `process.env` is a proxy that, while an action runs (the `AsyncLocalStorage` scope bunvex already keeps) or a
  package is imported, reads that execution's deployment variables first, then the server's own; outside, the
  server's own only.
- The push's modules are loaded with the deployment's variables, as Convex's analysis is (#589: before, the version a
  push installed read none at import).

### 3.3 Rule 5

No wire or stored name contains "convex": `nodeDependencies`, `externalDepsId`, `_external_deps_packages`,
`externalPackageId`, `externalDepsStorageKey`, `InvalidExternalModules` are used as they are. Convex's plugin name
(`convex-node-externals`) and its messages' "convex.json" become bunvex's.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| Q1 / DV-470 | The deployment installs with `bun install`, not `npm install`; a failure says `Command failed: bun install` with Bun's output | bunvex's server has Bun, not necessarily Node and npm (DV-87) | owner, 2026-10-12: A (Bun) |
| Q2 / DV-471 | Every dependency's install scripts run (`bun pm trust --all`), not only those of Bun's default trusted list | to match npm, which runs them all | owner, 2026-10-12: A (run them all) |
| Q3 / DV-472 | External packages live in the server's realm; while a Node action runs they read the deployment's variables first, then the server's | the packages load with Bun's own loader, as builtins (DV-169); Convex's packages see only the action's `process.env` | owner, 2026-10-12: C (the deployment's variables first) |
| Q4 / DV-473 | Extracted packages keep their Unix modes and symlinks: a package can spawn its own binary | Convex's AdmZip drops modes (`EACCES`) | owner, 2026-10-12: A (keep them) |
| — | "bunvex.json" in messages; no docs link in "No package.json found." | DV-170, DV-04 | covered |
| — | `"*"` never installs `bunvex`, `bunvex/*`, `@bunvex/*` | they are linked to the server (DV-168, DV-169) as Convex always bundles `convex` | Q5: matches Convex, stands (owner, 2026-10-12) |

### Q1 — the installer (DV-470)

- **Convex:** the Node executor runs `npm install` in a `package.json` of the exact versions (on Lambda for the cloud;
  on the machine's Node for the local backend).
- **bunvex:** runs `bun install` with the server's Bun, in the same kind of `package.json`.
- **Same?** No. The same exact top-level versions; transitive versions are resolved fresh by both (Convex ignores the
  app's lockfile too), so they usually agree, but Bun's resolver and its hoisted layout are not npm's. Registry
  settings: Bun reads `.npmrc` and `NPM_CONFIG_REGISTRY` like npm, plus `bunfig.toml`. A failure's text is Bun's
  (`error: No version matching "9.9.9" found for specifier "tiny-asset"`) under `Command failed: bun install`.
- **Why:** a choice, not "não dá pra fazer": bunvex could spawn `npm`, but its server would then need Node and npm on
  the host, which it otherwise never does (DV-87 runs Node actions in Bun). "Ainda não fizemos" an npm option either.
- **App impact:** low. Packages install and load the same; only an install failure's text, and in rare trees a
  transitive version, differ.
- **Options:** A, `bun install` (built); B, `npm install` (requires npm on the server; Node actions still
  run in Bun); C, `npm` when found, else Bun.
- **Recommendation:** A.
- **Decision (owner, 2026-10-12):** A — `bun install`, the server's own Bun; no npm on the server.

### Q2 — install scripts (DV-471)

- **Convex:** npm runs every dependency's `preinstall` / `install` / `postinstall` (unless the deployment's npm config
  says `ignore-scripts`; checked: with scripts on, `tiny-bin`'s `postinstall` ran during the push).
- **bunvex:** Bun runs only the scripts of packages in its default trusted list (the popular native packages) or the
  project's `trustedDependencies`; bunvex then runs `bun pm trust --all`, which runs the rest.
- **Same?** Yes with A (the scripts run, after the install instead of during it); no with B.
- **Why:** Bun's default is a security choice; npm's default is what Convex's apps get.
- **App impact:** with B, a native package outside Bun's list that builds or downloads its binary in a script would
  install without it and fail at import.
- **Options:** A, run them all (built); B, Bun's default list only.
- **Recommendation:** A.
- **Decision (owner, 2026-10-12):** A — every dependency's install scripts run (`bun pm trust --all`), as npm runs them.

### Q3 — what `process.env` the packages see (DV-472)

- **Convex:** packages run in the action's Node process, whose `process.env` is the deployment's variables plus a few
  of the process's (`PATH`, `PWD`, `LANG`, `NODE_PATH`, `TZ`, `UTC`) during each invocation; an SDK that reads
  `process.env.OPENAI_API_KEY` by default sees the deployment's key.
- **bunvex:** `"use node"` code runs in a `vm` context whose `process.env` is that view (STUDY-37), but packages
  loaded from `node_modules` run in the server's realm, as builtins do (DV-169): their `process.env` is the server's.
- **Same?** Not without a change. Options:
  - A, load the packages inside the Node context: a CommonJS/ESM loader of our own over `vm` (`compileFunction`
    wrappers, `SourceTextModule`s, JSON, `process.dlopen` for addons) — exact, but a project of its own;
  - B, while a Node action runs (Bun's `AsyncLocalStorage` scope bunvex already keeps), the server's `process.env` is
    exactly the action's view (Convex's), the server's own variables hidden from everything running in that scope,
    bunvex's own code included;
  - C, the same scope, but the deployment's variables read first and the server's after (built);
  - D, nothing: packages see the server's variables.
- **Why:** "Não dá pra fazer" cheaply: a package's module is evaluated once by Bun's loader in the server's realm.
- **App impact:** with D, an SDK under `"*"` that reads its key from `process.env` finds nothing; with C, packages also
  see the server's other variables (already reachable today from `"use node"` code through the `process` builtin;
  `vm` is not a boundary, DV-164); with B, any server code that reads `process.env` during an action would see the
  sanitized view.
- **Recommendation:** C.
- **Decision (owner, 2026-10-12):** C — while an action runs (or a package is imported), packages read the deployment's
  variables first, then the server's own.

### Q4 — file modes after extraction (DV-473)

- **Convex:** the zip keeps modes, but AdmZip's `extractAllTo` writes every file 0666 (checked: spawning a packaged
  0755 script fails with `EACCES`); symlinks (`node_modules/.bin`) are not restored as links.
- **bunvex:** extracts with the zip's modes and symlinks: what `bun install` wrote.
- **Same?** No: a package that spawns its own binary (`ffmpeg-static`, a prebuilt CLI) works on bunvex and fails on
  Convex.
- **Why:** "Ainda não fizemos" the other way: bunvex could drop the modes on purpose; keeping them is the plain
  extraction.
- **App impact:** only more works.
- **Options:** A, keep the modes (built); B, drop them as Convex.
- **Recommendation:** A.
- **Decision (owner, 2026-10-12):** A — extracted packages keep their Unix modes and symlinks.

### Q5 — `"*"` (same as Convex, to confirm)

- **Convex:** `"*"` makes every `package.json` dependency (all four kinds) a candidate except `convex` and local, URL
  or git versions; only those a `"use node"` file imports from the top-level `node_modules`, and their peer and
  optional dependencies, are installed.
- **bunvex:** the same, with `bunvex`, `bunvex/*` and `@bunvex/*` excluded: they are never bundled nor installed but
  linked to the server's modules (DV-168, DV-169).
- **Same?** Yes, mapped. **App impact:** none. **Recommendation:** confirm.
- **Decision (owner, 2026-10-12):** matches Convex; stands as designed.

### Q6 — network at push time (same as Convex, to confirm)

- **Convex:** the deployment reaches the npm registry during the push (a cache hit does not).
- **bunvex:** the same; the server's registry settings apply. An air-gapped deployment can point
  `NPM_CONFIG_REGISTRY` at a mirror, or not use `externalPackages`.
- **Same?** Yes. (An alternative would be an addition: the CLI installs and uploads `node_modules` itself.)
- **Recommendation:** confirm; no addition.
- **Decision (owner, 2026-10-12):** matches Convex; stands as designed (no addition).

### Q7 — where the install lives (same as Convex, to confirm)

- **Convex:** a zip in the modules storage and an `_external_deps_packages` row (kept forever); unzipped per process
  into the executor's temporary directory.
- **bunvex:** the same row and blob; unzipped (or moved, right after the install) per process into a temporary
  directory removed at exit. Nothing is installed into the app's or the server's own `node_modules`.
- **Same?** Yes. **Recommendation:** confirm.
- **Decision (owner, 2026-10-12):** matches Convex; stands as designed.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

- PR 1: `packages/cli/test/codegen.test.ts` "bunvex.json checks": the messages of §1.1, each from the 1.46.0 CLI on the
  same file (oracle run once), the key order, and that a valid list (with `"*"`) is read.
- PR 3, `packages/cli/test/external-packages.test.ts`, with a registry served by the test (`npm-registry.ts`:
  packuments and `tar`-made tarballs, every request recorded) and a Bun install cache of its own, so nothing reaches
  the network:
  - the CLI's rules (each case as the 1.46.0 CLI's `--write-push-request` gave it): only `"use node"` imports of listed
    packages, at their installed versions (a range in `package.json`); an isolate import bundled; `"*"` over all four
    dependency kinds, `bunvex` and `file:` versions excluded, undeclared packages bundled, a subpath and a `require`
    kept as written; peer and optional dependencies that are candidates, transitively; a nested copy bundled;
    Convex's three messages;
  - end to end with `bunvex deploy` and an in-process deployment: an action reads the file beside its package through
    an import and through `require`; a package's `postinstall` ran and its 0755 script runs (DV-471, DV-473);
    `_external_deps_packages` has Convex's fields and types, its blob's size and sha256; `_source_packages.externalPackageId`
    and `metadata.json`'s `externalDepsStorageKey`; another server on the same data loads them; a dry run installs and
    records them, the push then reuses them without a registry request, as does a push that changes only a module;
    another version is a new row; no import leaves `externalPackageId` null; a version the registry lacks is the
    400 `InvalidExternalModules` with nothing deployed; the deps count in `MAX_ZIPPED_PACKAGES_SIZE`; a CommonJS and an
    ES module package read the deployment's variables at import and when called, and the server's own (DV-472), while
    the action's `process.env` does not.
- PR 3, `packages/server/test/external-deps.test.ts`: the cache (the newest match, any order, a subset or another
  version no match, the 11th row out of reach); extraction (files, modes, a symlink that runs, the same directory
  again; a wrong sha256, an entry outside `node_modules/`, a `..` entry refused, a failure not remembered); the push's
  `nodeDependencies` (`BadJsonBody`).
- PR 3, `packages/differential/test/external-packages.test.ts` (local only; needs the oracle and `npm`): the app of
  `external-app/` on both backends with the same registry. Equal: a missing version's 400 `InvalidExternalModules`
  up to the installer's command (each asked the test's registry: npm's `ETARGET`, Bun's "No version matching"); a dry
  `start_push` answers a 32-character id, the same for the same packages in another order, null for none; the action
  reading the file beside its package by import and `require`; the install script ran on both. Asserted different,
  as decided by the owner: the packaged script is 0666 and `EACCES` on Convex, 0755 and runs on bunvex
  (DV-473); a package reads the server's own variable on bunvex only (DV-472). Convex's executor loses the backend's
  `npm_config_*` variables once it has run Node code, so both start with an app without Node modules and every
  install comes before the Node module's push.

**Sabotage** (PR 3; each restored, `git diff` clean after; a script applies each and runs the CLI and server tests):

| Break | Failed |
|---|---|
| the plugin never marks a package external | 4 CLI tests (the rules, end to end, the variables) |
| `"*"` ignored | 4 CLI tests |
| `file:` versions not excluded | the `"*"` test |
| peer and optional dependencies not followed | the peer test |
| any resolved copy taken, not only the top-level one | the peer test (the nested copy) |
| no cache: always install | the reuse test |
| the cache compares packages in order | the cache unit test |
| the cache looks at every row | the cache unit test |
| `bun pm trust --all` not run | the first end-to-end test (`postinstall`) |
| modes not restored on extraction | the extraction test |
| the zip writer drops modes | the extraction test |
| sha256 not checked | the refusal test |
| entries outside `node_modules/` accepted | the refusal test |
| `externalPackageId` not stored | 2 end-to-end tests |
| `metadata.json` without `externalDepsStorageKey` | the first end-to-end test |
| the deps not counted in the size limit | the size test |
| no variables scope for packages | the variables test |
| packages loaded with `import()` (no variables at import) | the variables test |
| a start ignores the packages | the first end-to-end test (the second server) |
| a failed install answered as `InvalidModules` | the failure test |

**Measurements** (no benchmark run; micro-measurements, this machine):

- The CLI's plugin runs only when the list has candidates. A `"use node"` build of `fast-check` and `typescript` (with
  an installed, unimported candidate, so the plugin sees every import): median 231 ms with it, 216 ms without (minimum
  211 and 209 ms): within noise.
- The server's `process.env` once the proxy is installed (only after a version with packages loads): a read costs 6.2
  ns outside an execution and 10.1 ns inside one, 2.0 ns without the proxy (2 000 000 reads, third run).
- A push without packages runs one more check (an empty list); one with packages, one query of at most 10 rows on a
  cache hit, an install on a miss (as Convex).

## 6. Open questions

None: Q1–Q7 decided (owner, 2026-10-12).

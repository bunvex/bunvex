# STUDY-95 — A function's error stack: the app's frames, mapped to its sources

- **Status:** implemented; S1 and S2 accepted as recommended (owner, 2026-10-04)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-35](STUDY-35-push-and-deploy.md) (bundling, source maps), [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md)
  N2 (a nested error's display), [STUDY-65](STUDY-65-convex-tests-application-client-cli.md) M5 (source
  positions), the examples' browser run (STUDY-90), which found it.

## 1. How Convex does it

- **The frames.** `udf-runtime/src/errors.ts` `setupSourceMapping` installs `Error.prepareStackTrace`, which
  records V8's call sites as `FrameData` (`fileName`, 1-based `lineNumber` and `columnNumber`, function and
  type names, `isAsync`, …) and asks the `error/stack` op for the string. An uncaught error goes through
  `crates/isolate/src/error.rs` `extract_source_mapped_error` the same way.
- **The mapping.** `crates/common/src/errors.rs` `JsError::from_frames` (l. 694–770), per frame:
  - a frame whose file is not a URL is dropped; a frame whose module has no source map is dropped
    (`lookup_source_map` → `None` → `continue`);
  - else the token at `lookup_token(line, column)` gives the file (`token.get_source()`, the map's `sources`
    entry as is), line (`get_src_line()`) and column (`get_src_col()`); a frame with no token is kept as it was;
  - frames without a location (native code) are kept;
  - leading and trailing frames inside Convex's own harness (`is_omittable_internal_frame`, l. 506: files
    containing `udf-runtime/src` or `convex/src/server/impl`) are dropped.

  `lookup_token` takes a **0-based** line and column (the `sourcemap` crate), and V8's are **1-based**: Convex
  looks up one line and one column further, and prints the token's 0-based position. On esbuild's output (one
  statement per line), that next line's token is usually the next original line, so the printed line is
  usually the right 1-based line, and the column is a 0-based token column.
- **The text.** `FrameData`'s `Display` (l. 514–568): `    at [async ]<fn> (<file>:<line>:<col>)`, or
  `    at <file>:<line>:<col>` without a function name. `JsError`'s `Debug`: the message, a newline, then one line
  per frame, each ending with a newline.
- **The paths.** The CLI bundles with esbuild, `outdir: "out"` from the project's directory (`bundler/debugBundle.ts`
  l. 60–90, `keepNames: true`), and pushes each module's map (`bundler/index.ts` l. 236–260). esbuild names a
  map's sources relative to the output file: `out/messages.js` names `../convex/messages.ts`, a shared chunk
  `out/_deps/<hash>.js` names `../../convex/…`, a bundled package `../node_modules/<pkg>/…`. Those are the paths
  frames show.
- **Where it shows.** The client's error message (the `JsError` display), the function logs (exception events
  carry the mapped `FrameData`), `npx convex run`, an analyze failure at push, a nested call's error for its caller
  (STUDY-41 N2), and `error.stack` / `console.trace` inside a function (the same `error/stack` op).

## 2. What an app observes

Only its own frames — never the runtime's — each naming its source file (`../convex/messages.ts`), line and
column, wherever the error surfaces: the browser console, `run`, logs, a failed push, a caller's catch.

## 3. How bunvex did it, and does now

**Before:** `describeUncaught` (`packages/server/src/errors.ts`) kept every `at` line of the JS stack: the server's
frames (`functions.ts`, `engine.ts`, `sync.ts`, `node:async_hooks`) and the app's under the bundled module's
name (`messages.js:31:28`, `_deps/fys4j41q.js:9:16`). The pushed source maps were stored (#366) but only used for
analyzed positions.

**Now:**

- **`stack-map.ts`.** Each loaded code version registers its modules' maps (`registerModules`) and gives every
  module the `sourceURL` `bunvex:/<version>/<path>` (`moduleUrl`): its frames say which version and module they
  are, so two versions (a hot swap, two deployments in one process) never map each other's. `mapStack(stack)`:
  - a pushed module's frame is mapped through its map (`SourceMapTokens.original`, `sources` read alongside
    `mappings`), to the source file the map names, 1-based line and column (S2); with no answer, the module path;
  - every other located frame — the server's, Node's — is dropped (Convex drops frames with no module map);
  - frames with no location (native code) are kept between the app's frames and trimmed before and after them
    (Convex trims its harness's);
  - a stack with no pushed module's frame is returned as it is: functions registered in-process
    (`Functions.register`, `@bunvex/testing`) are not pushed code, and Convex has no such mode.

  The maps are held weakly by the registry and strongly by the version's `vm` contexts, so they live exactly as
  long as code that can throw.
- **Everywhere errors surface.** `describeUncaught` (client message, logs' error text, `run`, schedulers, crons,
  HTTP actions, an analyze failure) maps the stack after the message; `stackFrames` (the log's exception events)
  maps first; `console.trace` maps its frames.
- **A nested call's error** is raised for the caller with the frames of the caller's `ctx.runQuery` /
  `ctx.runMutation` call (captured when it is called), as Convex raises it in the caller's code; its message keeps
  the nested display (STUDY-41 N2), now mapped.
- **The paths, as Convex's.** `Bun.build` names a map's sources from the process's directory (`bunvex/messages.ts`);
  the CLI now renames them as esbuild with `outdir: "out"` would, from the project's directory
  (`withSourcesFromOut`): `../bunvex/messages.ts`, `../../bunvex/lib/check.ts` for a shared chunk,
  `../node_modules/<pkg>/…` for a bundled package.

The CLI already bundled to JavaScript with external source maps, and pushed them: no build change was needed
beyond the `sources` names.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| S1 | A frame's function name is JavaScriptCore's: a name the bundler changed (`assertShort2`, `$explode`) shows changed, an inline handler shows `<anonymous>`, and a strict-mode tail call (`return f()`) has no frame for its caller. Convex's (V8, esbuild `keepNames`) show the original names and every caller | the engine: JavaScriptCore names a frame by the declared identifier (Bun's `minify.keepNames` changes `fn.name`, not the frame), and implements proper tail calls. Mapping names through the map's `names` is possible later | accepted (owner, 2026-10-04): DV-345; mapping names through the map is a follow-up |
| S2 | A frame's line and column are the original 1-based position the source map defines (the token at or before the frame's position, looked up 0-based). Convex passes the 1-based position to the 0-based lookup and prints the token's 0-based position, which on esbuild's output usually shows the right line and a 0-based column | Convex's arithmetic tracks esbuild's output layout; over Bun's output it shows the wrong line (seen: a throw on line 3 printed as line 2, a call on line 5 as line 6). The right line is what Convex's users see | accepted (owner, 2026-10-04): DV-346 |

Not divergences: dropping the server's frames (Convex has none of them, its harness's are dropped); the sources'
names (now Convex's).

Gap, for later: a function reading `error.stack` itself (or logging it as a string) still sees the raw frames,
`bunvex:/<version>/<module>.js`, where Convex's `prepareStackTrace` maps those too.

## 5. Tests

- `packages/cli/test/error-stacks.test.ts`, a real bundle and push:
  - the client's message for a mutation that calls a helper in another module that throws: exactly the throw
    (`../../bunvex/lib/check.ts:3:…`, through a shared chunk) and the call (`../bunvex/posts.ts:7:3`), no server
    frame, no bundled name;
  - a bundled package's frame (`../node_modules/tiny-lib/index.js:2:…`);
  - a nested call: the nested display mapped, then the caller's `ctx.runMutation` line;
  - `bunvex run` prints the same frames; a push failing at import shows only `../bunvex/broken.ts:4:…`.
- `packages/server/test/stack-map.test.ts`: mapping, dropping, keeping native frames between the app's and
  trimming them at the ends, an unknown version or module, stacks with no pushed frame untouched, and the log's
  exception frames.
- Sabotage, each caught: no mapping (7 failures), no filtering (7), the nested error keeping the server's frames
  (1), the sources named as Bun names them (5).

**Cost.** An error with 8 app and 10 server frames: `describeUncaught` 5.9 µs instead of 2.4 µs (the map decoded
once per module). A nested call captures its call site: 2.5 → 2.8 µs for a trivial nested query.

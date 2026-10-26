# STUDY-188 — What Convex's removed runtime tests pin that bunvex does not

- **Status:** decided (owner, 2026-10-25: every §5 recommendation; DV-553, DV-482 amended). R1 and R3 built; each other item ships on its own PR from `main`.
- **Convex source read:**
  - get-convex/convex-backend at `precompiled-2026-10-24-bb31399`;
  - the removed tests, from the snapshots `bea52bde0` (Rust: `crates/isolate/src/tests/{import,globals,async,adversarial}.rs`, `crates/sync/src/tests.rs`, `crates/common/src/{auth,schemas/json}.rs`) and `c358201e1` (TS: `js-integration-tests/stacktrace_node.test.ts`).
- **Oracle:** Convex's binary `precompiled-2026-10-24-bb31399`. Every item below was run on it and on bunvex `main` (`e5e00809`), with the same app deployed by each CLI through the differential harness (`startConvex` / `startBunvex`). Calls went over `/api/{query,mutation,action}` and the sync socket. The test-gap report this study comes from was not trusted: each claim was run again, and two were wrong (X4's "AuthError" for a bad identity, X19 b).
- **Split:** the data, schema and import items (X1–X3, X5, X6, X10, X12, X13, X18, X20) are in STUDY-187 (#837). The type-level items (T1–T6) are in [STUDY-189](STUDY-189-public-type-mismatches.md).
- **Related:** DV-482 (stack frames), [STUDY-34](STUDY-34-admin-keys.md) §1.2 (admin auth on the socket), STUDY-35 (auth config), [STUDY-171](STUDY-171-function-sandbox-seam.md) (the `process` executor), [STUDY-186](STUDY-186-convex-after-72ce13c.md) A6, and the action timers in [STUDY-174](STUDY-174-silent-bugs.md).

## 1. The items, as run on both backends

### X4 — admin auth on the sync socket (confirmed, wider than reported)

Each row is a `Connect`, then `Authenticate { tokenType: "Admin", baseVersion: 0 }`. Neither side sends a close
frame (code 1005).

| Case | Convex | bunvex |
|---|---|---|
| wrong admin key | `AuthError` "The provided admin key was invalid for this instance", `authUpdateAttempted: true` | the same, with `authUpdateAttempted: false` |
| valid key, `impersonating: {}` or `{ subject }` only | `FatalError` "Received Invalid JSON on websocket: Either "tokenIdentifier" or "issuer" and "subject" must be set" | `FatalError` "Malformed Authorization header." |
| valid key, `impersonating: "x"` / `{ issuer: 1, … }` | `FatalError` "Received Invalid JSON on websocket: invalid type: …" (serde's text) | `FatalError` "Malformed Authorization header." |
| wrong key and malformed `impersonating` | `FatalError` "Received Invalid JSON …" (the message is parsed before the key is checked) | `AuthError` (the key is checked first) |
| User token "nonsense"; a valid key | the same on both sides | |

- **Convex:**
  - `sync/src/worker.rs` `fetch_identity` turns any rejection into `AuthUpdateFailed`. `local_backend/src/subs/mod.rs:278-289` sends it with `auth_update_attempted: Some(true)`. This came in with `848899ea5`, which is already before the reference.
  - A malformed acting identity fails at message parse (`sync_types/src/types/json.rs:926`, `:434`). `subs/mod.rs:173` sends that failure as a `FatalError`.
- **bunvex:** `server/src/sync.ts` (the `Authenticate` case) passes `false`, and parses `impersonating` after the key check, through `admin-keys.ts`' header parser. `server/test/admin-access.test.ts:297` and STUDY-34 §1.2 pin `false`; both are wrong.

### X7 — the auth config's provider `domain` (confirmed, wider than reported)

Convex refuses with `400 InvalidAuthConfig` "… Invalid provider domain URL "<d>": Does not look like a URL (must
have a scheme or end with a top-level domain)".

| domain | Convex | bunvex |
|---|---|---|
| `idont.looklikeadomain`, `example.local`, `example.internal`, `foo.test` | refused | accepted |
| `foo.xn--p1ai` (a punycode TLD) | accepted | refused |
| `localhost`, `example.com`, `EXAMPLE.COM`, `https://idont.looklikeadomain`, `http://127.0.0.1:3211` | accepted | accepted |
| `file://foo.com`, `127.0.0.1`, `foo.com.` | refused | refused, same reason |

- **Convex:** `common/src/auth.rs:243` `ends_with_tld`. `localhost` passes. Otherwise the last label of `Url::parse`'s host (lowercased, punycoded) is looked up in the `tld` crate 2.36.0: IANA's `tlds-alpha-by-domain.txt` of 2024-08-06, 1 446 names, 151 of them `xn--`.
- **bunvex:** `auth/src/config.ts:27` approximates it with `/\.[a-z]{2,}$/i`.
- **Wording, found on the way:**
  - Convex prefixes every auth-config refusal with "The pushed auth config is invalid: " (`application/src/lib.rs:2167`, `isolate/src/client.rs:1053`).
  - An auth config that throws is "The pushed auth config is invalid: Uncaught Error: boom …" on Convex, and "Hit an error while evaluating your auth config:\nFailed to analyze auth.config.js: …" on bunvex (`server/src/push.ts:323-351`).
  - `domain: 5` is serde's "data did not match any variant of untagged enum SerializedAuthInfo" on Convex, and "provider at index 0: `domain` must be a string" on bunvex.

### X8 — `v.literal(Infinity | -Infinity | NaN)` (confirmed)

- **Convex:** refuses the push with `400 UnsupportedFloatLiteral` "Infinite or NaN values are not supported in literal validators." The literal can be in the schema, in `args`, in `returns`, or nested (`v.optional(v.union(…, v.object({ y: v.literal(-Infinity) })))`). The check is in `common/src/schemas/json.rs:808-820`: `Number::from_f64` has no value for them.
- **bunvex:** pushes all of them.
- Both sides accept `-0` and `1.5`.

### X9 — iterating a query again (confirmed, wider than reported)

| Probe | Convex | bunvex |
|---|---|---|
| `for await` twice | "This query is closed and can't emit any more values." | "Iteration can only begin on a query once." |
| `collect()` then `for await` | "… closed …" | "… has been chained with another operator and can't be reused." |
| `collect()` twice | "… closed …" | "… chained …" |
| `take(1)` then `for await` | "… chained …" | "… chained …" (matches) |

- **Convex:** `npm-packages/convex/src/server/impl/query_impl.ts:153-276`.
  - A query goes preparing → executing → consumed. It becomes consumed when its stream ends, or on `return()`.
  - `take` / `first` / `unique` / `paginate` mark it closed instead (the "chained" text).
  - `collect()` is a `for await` over the query itself, so it consumes the query.
- **bunvex:** two flags, `iterated` and `closed` (`core/src/tx.ts` ~2880–2978, and `sandbox/src/child-db.ts:57,180`), so "consumed" is never reached.

### X11 — DV-482 against agent-base (confirmed, worse than reported)

- **Convex:** its binary runs `"use node"` actions on local Node (v24 here). `new Error().stack` there keeps Node's frames: `at request (node:https:697:10)`, `at ClientRequest (node:_http_client:380:17)`, and the executor's own frames. `node-executor/src/errors.ts:98-101` keeps them on purpose, "because proxy-agents depends on Node-formatted frames". The removed `stacktrace_node.test.ts` pins them.
- **bunvex:** DV-482 keeps only the app's frames, in Node contexts too (`server/src/app-errors.ts` `installAppErrors`).
- **The consequence.** agent-base 7.1.4 and 9.0.0 (under https-proxy-agent 9.1.0) look for `node:https:` in a fresh stack, inside `get protocol()`, whenever the request sets neither `secureEndpoint` nor `protocol`.
  - On bunvex that check is false, and Bun's `ClientRequest` then throws `Protocol "https:" not supported. Expected "http:"`. So `https.request(url, { agent: new HttpsProxyAgent(…) })` fails outright.
  - On Convex, and on plain Bun outside bunvex (whose stack has `at request (node:https:18:119)`), it works.

### X14 — dynamic `import()` (confirmed, wider than reported)

Both CLIs keep `import("./helpers")` as a runtime import of the entry module.

| Probe | Convex | bunvex |
|---|---|---|
| in a query or mutation | `Uncaught TypeError: dynamic module import unsupported` | `Uncaught TypeError: A dynamic import callback was not specified.` (Node vm's text) |
| in an action | works; a second import gives the same namespace | the same vm `TypeError` |
| missing path, in an action | rejects with `Error: Couldn't find JavaScript module 'nonexistentPath'. Did you forget to run \`npx convex dev\`?` | the vm `TypeError` |
| a module that throws while loading, in an action | the function fails with `Uncaught Error: boom` even inside `try`/`catch` | the `catch` gets the vm `TypeError` |

- **Convex:**
  - `isolate/src/request_scope.rs:210-211` installs the real callback for actions only (`allow_dynamic_imports`).
  - Every other function gets the "dynamic module import unsupported" callback (`isolate.rs:192,259`, `strings.rs:67`).
- **bunvex:** `server/src/code-version.ts:431` creates each `vm.SourceTextModule` without `importModuleDynamically`.
  - Bun 1.4.4 calls the callback when one is given (probed).

### X15 — `self` (confirmed)

- **Convex:** `npm-packages/udf-runtime/src/00_misc.ts:64` sets `self = globalThis`. In queries and actions, `typeof global` is `"undefined"` and `self === globalThis`.
- **bunvex:** `contextGlobals` never sets `self`, so `typeof self` is `"undefined"` and `self === globalThis` throws `ReferenceError` (`server/src/code-version.ts:281`).
- `global` is undefined on both sides in V8 functions.
- Libraries that find the global object through `self` (lodash's root check, Convex's test case) take another path on bunvex.

### X16 — returning a promise that never resolves (partly confirmed)

| Function | Convex | bunvex |
|---|---|---|
| query, mutation | fails in 7 ms: "Returned promise will never resolve" (no "Uncaught") | HTTP 408 after 300 s; the run stays pending, holding its permit and transaction |
| action | HTTP 408 after 300 s | 408 after 300 s (matches) |

- **Convex:** `isolate/src/environment/udf/mod.rs:1252-1256`. Once no syscall is pending and microtasks are drained, a pending result is an error.
- **bunvex:** the query and mutation bodies in `server/src/functions.ts` (`queryBodyOf` ~1844, `invoke` ~2014). The 1 s user-time limit does not tick while the function is idle.

### X17 — `eval`, `Function`, `Atomics.wait`, memory (confirmed; Convex's memory message differs from the report's)

Same result in queries, mutations and actions:

| Probe | Convex | bunvex |
|---|---|---|
| `eval("1+1")`, indirect `eval`, `new Function("return 2")()` | `EvalError: Code generation from strings disallowed for this context` | returns the value |
| `Atomics.wait(…)` | `TypeError: Atomics.wait cannot be called in this context` | `"timed-out"` / `"not-equal"` |
| `new ArrayBuffer(512 MiB)`, `new ArrayBuffer(4 GiB)`, a 512 MiB `Blob` | an uncatchable "JavaScript execution ran out of memory (maximum memory usage: 64 MB)" | allocated |

- **Convex:**
  - `isolate/src/client.rs:518` (`--disallow-code-generation-from-strings`);
  - `isolate.rs:195` (`set_allow_atomics_wait(false)`);
  - `array_buffer_allocator.rs:102` and `isolate.rs:170`, with the knobs `ISOLATE_MAX_USER_HEAP_SIZE` and `ISOLATE_MAX_ARRAY_BUFFER_TOTAL_SIZE` (64 MiB each, `knobs.rs:1165,1174`);
  - `termination.rs:346` (the message).
- **bunvex:**
  - `vm.createContext` without options (`server/src/code-version.ts:407-409`).
  - On Bun 1.4.4, `codeGeneration: { strings: false }` gives Convex's exact `EvalError` for all three forms (probed).
  - A `vm` context cannot cap its own memory in a shared process.

### X19 — results after the function returns

- **(a) Confirmed, narrow.** In Convex's `asyncTests:queryDangling`, the query returns an array and a dangling `.then` pushes to it.
  - Convex serializes the result as soon as the promise is fulfilled, before the final microtask drain. Its syscalls resolve only from the event loop (`udf/mod.rs` ~1240–1262).
  - With an empty table, bunvex returns `[null]`, because its read resolves within microtasks and the value passes through several awaited layers before it is serialized (`functions.ts:1857`). Convex returns `[]`.
  - With one document, both return `[]`.
- **(b) Not confirmed.** Over the public API, both backends answer "Could not find public function for '_deps/nonexistent'." Convex's "Refusing to run … within the '_deps' directory" is behind the public lookup.
- **Found on the way (X21).** In an action, `ctx.runQuery` / `runMutation` / `runAction` on a path that does not exist:
  - Convex throws `Error: Couldn't resolve api._deps.nonexistent.default`;
  - bunvex throws `FunctionPathError: Could not find public function for '_deps/nonexistent'.`
  - The general case (any missing path) is not checked yet.

## 2. What an app observes

- **Fails on bunvex and works on Convex:**
  - a dynamic import in an action (X14);
  - a library that reaches the global object through `self` (X15);
  - https-proxy-agent in a `"use node"` action (X11);
  - a provider on a punycode TLD (X7).
- **Works on bunvex and fails on Convex** (an app tested on bunvex breaks when it moves):
  - `eval` / `new Function` (X17), as some template and schema libraries use;
  - a function holding more than 64 MB (X17);
  - `v.literal(Infinity)` (X8);
  - a provider domain on a non-existent TLD (X7).
- **Different text or timing:**
  - X4's frames;
  - X9's messages;
  - X16, 7 ms against 300 s, with a held permit meanwhile;
  - X19 (a);
  - X21;
  - the auth config prefixes (X7).

## 3. How bunvex changes (one PR each, from `main`)

| # | Change | Waits on |
|---|---|---|
| R1 (X15) | `self = globalThis` in the isolate context (`code-version.ts`) | — |
| R2 (X17a) | `codeGeneration: { strings: false }` on the isolate context. `Atomics.wait` shadowed by a function that throws Convex's `TypeError`. bunvex's own host-side `runInContext` calls checked to still work (they are host-initiated) | — |
| R3 (X8) | The validator JSON parser (`server/src/validator-json.ts`) refuses a non-finite float literal: `UnsupportedFloatLiteral`, Convex's message word for word (it names nothing of Convex) | — |
| R4 (X7) | `ends_with_tld` matched exactly. The `tld` 2.36.0 list (IANA's public file, 1 446 names, ~5 KB gzipped) becomes a bunvex data file, checked as a `Set` against the `URL` host's last label. Moved when Convex bumps the crate. The auth config's messages get Convex's prefix "The pushed auth config is invalid: " | — |
| R5 (X4) | `authUpdateAttempted: true` for a refused admin key. `impersonating` validated while the message is parsed, before the key, as a `FatalError` "Received Invalid JSON on websocket: …". STUDY-34 §1.2 and `admin-access.test.ts:297` corrected | — |
| R6 (X14) | `importModuleDynamically` on every module. In an action it resolves against the code version's module map, caching the namespace. A missing path rejects with "Couldn't find JavaScript module '<path>'. Did you forget to run \`bunvex dev\`?". Elsewhere it rejects with `TypeError("dynamic module import unsupported")`. A module that throws while loading fails the function (Q3) | — |
| R7 (X21) | `ctx.run*` on a missing path: Convex's `Error: Couldn't resolve api.<path>`. Probe the general case first | — |
| R8 (X9) | Convex's four query states in `core/src/tx.ts` and `sandbox/src/child-db.ts` | STUDY-187's X20 and X13 (same file) |
| R9 (X16) | A query or mutation whose promise is still pending once nothing is in flight (X13's counter) and a macrotask has passed fails with "Returned promise will never resolve" | X13 |
| R10 (X19a) | The result is snapshotted where the handler's promise settles, not after the wrappers | X13 (the same run loop) |
| R11 (X11) | Per Q2 | Q2 |
| R12 (X17b) | Per Q1 | Q1 |

Each PR comes with a differential test (both backends, the answers above), a sabotage check and, for R2 and R6, a
measurement of module load and context creation.

## 4. Divergences

- **DV-553** (Q1): no memory cap under `vm`; Convex's 64 MiB cap under the `process` executor (R12).
- **DV-482**, amended (Q2): the runtime's `node:` frames are kept in `"use node"` contexts (R11).
- Q3: R6 matches Convex (a module that throws while loading fails the function); no divergence.
- **DV-569** (owner, 2026-10-25): the rare-error texts, frames and timings the PRs left different, one entry for all of them. Each PR lists its own: #852 (X4), #853 (X7), #855 (X14), #856 (X9), #857 (X21), #858 (X16), #859 (X19). The `process` executor's differences in #855 and #856 are fixed to match Convex, not recorded.
- **Known gap** (X19a, #859): bunvex's reads can resolve within microtasks, while Convex's never do. A dangling chain that reads and then changes the result within two microtask turns can still differ. Exact parity needs every read to answer on a later turn; not planned.

## 5. Owner questions

Decided (owner, 2026-10-25): every recommendation below.

| # | Question | Recommendation (decided) |
|---|---|---|
| Q1 (X17 memory) | Convex caps each function at 64 MB of heap and 64 MB of array buffers, uncatchably. A `vm` context in bunvex's process cannot do that. Options: (a) record a DV, no cap under `vm`; (b) approximate it by wrapping `ArrayBuffer` / `Blob` / typed arrays, which is incomplete because strings and objects stay uncapped; (c) cap it only under STUDY-171's `process` executor (a child's heap limit), with a DV for `vm` | (c). Under `vm`, record the DV plainly rather than half-cap it; the `process` executor can cap the heap for real |
| Q2 (X11) | DV-482 strips `node:` frames in `"use node"` actions, which breaks agent-base / https-proxy-agent (a hard error). (A) keep the runtime's `node:` frames in `"use node"` contexts (still no server paths) and amend DV-482; (B) keep DV-482 and record the consequence and its workaround (`protocol: "https:"` / `secureEndpoint: true`, or `fetch`) | (A). Convex keeps those frames on purpose, for this library |
| Q3 (X14) | On Convex, a dynamically imported module that throws while loading fails the whole function, even inside `try`/`catch`. Match that, or let the `catch` see the error (what JavaScript normally does)? | Match Convex: an app that catches it on bunvex would fail on Convex |

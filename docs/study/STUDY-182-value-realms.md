# STUDY-182 — The realm of the values pushed code receives
<!-- index: The realm of the values pushed code receives: every path hands it the server's objects (args, `ctx.db` reads, nested results, errors, `process`, web APIs), so `instanceof Object/Array/ArrayBuffer/Error` fail where Convex's hold; options measured (a boundary copy at about +2 µs per KB), the other direction's `instanceof` bugs | decided (owner, 2026-10-21): R-1–R-5; DV-547, DV-548; the other direction built (#807) -->

- **Status:** decided (owner, 2026-10-21): R-1–R-5 as recommended (§7); DV-547 and DV-548 decided. The other
  direction is built (#807).
- **Convex source read:** `72ce13c`, the reference commit:
  - `npm-packages/convex/src/values/value.ts` (`jsonToConvex`, `convexToJsonInternal`);
  - `server/impl/registration_impl.ts`, `database_impl.ts`, `query_impl.ts`, `syscall.ts`;
  - `udf-runtime/src/02_structured_clone.ts`, `23_request.ts`.
- **bunvex source:** `main` at `3d4e8bf2`. Paths are relative to `packages/`. Probes and benchmarks were run on Bun 1.4.2.
- **Found by:** `@bunvex/helpers`' pagination differential test (#804). A document's `v.bytes()` field failed `instanceof ArrayBuffer` in a pushed function.
- **Related:**
  - DV-164 (one `vm` context per code version) and STUDY-152 C3 (per component);
  - [STUDY-18](STUDY-18-value-model.md) §9, the other-realm checks;
  - [STUDY-35](STUDY-35-push-and-deploy.md) §3.1, values leaving a context;
  - [STUDY-171](STUDY-171-function-sandbox-seam.md), the process sandbox;
  - DV-169 and DV-472, where builtins and external packages run in the server's realm.

## 1. How Convex does it

Every value a function receives is built inside the isolate, by the `convex` library bundled into the app:
- **Args:** `jsonToConvex(JSON.parse(argsStr))` (`registration_impl.ts:55, 335, 503`).
- **Documents and query results:** `jsonToConvex` (`database_impl.ts:43, 80, 106`; `query_impl.ts:270, 307`).
- **Syscall results:** `JSON.parse` in the isolate (`syscall.ts:25, 54`).
- **Errors:** re-created in the isolate, as `new Error(message)` or `new ConvexError` with its data (`syscall.ts:44-52`).
- **Web APIs:** the isolate has its own `structuredClone`, `Request` and the rest (`udf-runtime`).
- **Node actions:** they run in a plain Node process, in one realm.

So in a Convex function, `doc instanceof Object`, `arr instanceof Array`, `bytes instanceof ArrayBuffer`, `e instanceof Error` and `Object.getPrototypeOf(doc) === Object.prototype` are all true.

## 2. What an app can observe

Plain JavaScript checks on what it receives:
- `instanceof Object`, `Array`, `ArrayBuffer`, `Uint8Array` and `Error`;
- `Object.getPrototypeOf(x) === Object.prototype`;
- `x.constructor === Object`.

Also, a library's own `instanceof` on them. For example, zod's `z.instanceof(ArrayBuffer)` fails with "expected ArrayBuffer, received ArrayBuffer".

lodash's `isPlainObject` / `isArrayBuffer` / `cloneDeep` / `isEqual`, `is-plain-obj`, and zod's `object` and `array` parsing do not depend on the realm. They work either way.

## 3. How bunvex does it

Pushed code runs in its own `vm` context. The values it receives are made on the server, in the server's realm. A probe walked every value a pushed function receives. Each path below hands it server-realm objects:

| Path | Where the value is made |
|---|---|
| Handler args | `fromJsonValue` on the host (`values/src/value.ts:339-379`); the handler gets them as they are (`server/src/functions.ts:2014, 2860`) |
| `ctx.db` reads: `get`, `collect`, `first`, `unique`, `take`, iteration, `paginate`, `db.system`, search | `decodeDoc` (`core/src/tx.ts:1275, 1517, 2746`); a document this transaction wrote, the host's `structuredClone` (`tx.ts:1259`) |
| `ctx.runQuery` / `runMutation` / `runAction` results | `copyValue` (`functions.ts:74`): objects are server-realm; arrays and buffers keep the callee's realm |
| `ctx.auth.getUserIdentity()`, `ctx.meta.*`, storage metadata, `ctx.vectorSearch` results | Host objects |
| Errors the engine throws | Server `Error`s. Their stacks are rewritten (`app-errors.ts:65-80`), but `e instanceof Error` is false in the app, and so is it for the app's own `new BunvexError()` (`app-errors.ts:113-127`) |
| HTTP actions: `Request`, its `headers`, `req.json()` | The context's `Request` / `Response` are the server's classes (`code-version.ts:316-322`) |
| `process`, `process.env` | Host objects (`code-version.ts:329`; `env-scope.ts:26-46`) |
| `bunvex/values` / `bunvex/server` | Linked as the server's modules (`code-version.ts:140-145`), so `v.object(...)` is a server object |
| `structuredClone`, `TextEncoder`, `crypto`, `Blob`, `fetch().json()` | The host's: a Bun `vm` context has no web APIs of its own |

`Date` is already right: the context's own, made deterministic (`core/src/determinism.ts:581-593`). The process sandbox (AD-44) has the same issue, because its child decodes the wire in its own main realm (`sandbox/src/wire.ts:229-250`).

**The other direction**, server code reading the app's values, mostly works: `isSimpleObject`, `isBytes`, `compareValues` and `toJsonValue` accept another realm. But a few checks use `instanceof`:
- **A bug.** `core/src/shapes.ts:87` checks `instanceof ArrayBuffer`. Bytes written by pushed code are summarised as `Object {}` instead of `Bytes` in the table's shape, which `/api/shapes2` and the dashboard read.
- **Correct today only by accident.** These are fed decoded values today, so the `instanceof` holds; a value from the app's realm would fail it:
  - `server/src/audit-log.ts:106`;
  - `values/src/export-json.ts:60`;
  - `server/src/streaming-export.ts:107`;
  - `core/src/search-segments.ts:321`.
- **Edge case.** `functions.ts:1385`: an app-realm error loses its message in the log stream's `exception` event.

### 3.1 The fix, measured

Five ways to give pushed code values of its own realm were measured. The documents were nested objects and arrays, strings, numbers, a bigint and bytes. Costs are medians in µs:

| Option | Right realm | 1 KB | 100 KB | Per KB |
|---|---|---|---|---|
| Today (`decodeDoc`, host realm) | no | 9.9 | 890 | 8.9 |
| **A: a host-side copy into the context's realm** (its `Object.prototype`, `Array`, `ArrayBuffer`), applied where values cross | yes | +2.0 | +225 | **+2.0–2.2** |
| B: JSON through the context (host `stringify`, context `JSON.parse`, fix-up) | yes | 16.9 total | 1,758 total | 17.5 |
| C: lazy proxies | partly (bytes must be copied; identity, `structuredClone` and inspection break) | ~0 to wrap | 5× per read | — |
| D: decode straight into the context's realm in `Tx` (replaces `decodeDoc`, no extra pass) | yes | 5.6 | 512 | 5.1–5.6 (as today's host decode) |

Two findings:
- Building objects in the context's realm costs nothing extra in itself. D is within noise of the same decoder building host objects.
- A, the boundary copy, adds about 2 µs per KB that crosses into app code. With a typical mutation taking about 20 µs, reading one 1 KB document costs about 10% more, and a 200 B document about 0.4 µs.

**Proposed** (R-1, R-2):
1. **A at the boundary.** A host-side `intoRealm(value)` deep-copies plain objects, arrays and `ArrayBuffer`s into the context's realm. It leaves class instances, functions and the commit-timestamp placeholder alone. It is applied at:
   - every `ctx.*` result, at the one choke point they all pass through (`app-errors.ts:81-106`, under both executors);
   - the args, at the handler call sites (`functions.ts:2014, 2860`; `sandbox/src/child-call.ts:454`, `child-action.ts:260`);
   - `structuredClone`;
   - `process` / `process.env`.
2. **Errors through a `Symbol.hasInstance` on the context's `Error` family** (a slot check, about +25 ns per `instanceof Error`). The engine needs the server's error object back (`OccError`, system errors), so the error is kept rather than re-created as Convex does.
3. **The other direction fixed now**, since it is a bug and needs no decision: `isBytes` replaces `instanceof ArrayBuffer` at the five places above, and the log stream reads an app-realm error correctly.
4. **D later, only if a measurement calls for it.** It would remove the copy for `ctx.db` reads, but every decoder would need to know the running context.
5. **Web APIs as a separate item** (R-4): `TextEncoder`, `crypto`, `Blob`, the HTTP action's `Request`.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-547 | `"use node"` actions keep the values they receive in the server's realm | External packages and builtins live in the server's realm (DV-169, DV-472); values from the context's realm would be foreign to the packages' own `instanceof` | owner, 2026-10-21 (R-3) |
| DV-548 | Errors keep the server's object; `instanceof Error` holds through `Symbol.hasInstance` on the context's `Error` family, where Convex re-creates the error in the isolate | The engine needs the original (`OccError`, system errors) | owner, 2026-10-21 (R-2) |

Fixing the realm of what pushed code receives is a gap fix (§1), not a divergence.

## 5. Tests

- A probe app, run under both executors (`vm` and `process`), walks every value of every path in §3 inside the function. It asserts each value's realm: `instanceof`, prototype and constructor checks. It also asserts `e instanceof Error` for every error the engine throws, and for the app's own `BunvexError`.
- A differential check: the same probe on Convex's binary gives the same answers.
- The other direction: bytes written by pushed code are summarised as `Bytes`.
- Sabotage: skip the copy at the boundary, and the probe fails.
- Measurement: the mutation benchmark (1 KB and 100 KB documents), before and after.

## 6. Not verified yet

- How much app code in the wild relies on these checks. Convex apps assume a single realm, so any `instanceof` works there.

## 7. Questions for the owner

All decided by the owner on 2026-10-21, as recommended.

| # | Question | Recommendation |
|---|---|---|
| R-1 | Give pushed code values of its own realm, as Convex does, at a cost of about +2 µs per KB crossing into app code (A) | **Yes.** `e instanceof Error` and `x instanceof Array` must work as on Convex. The cost is small next to a mutation's, and D can remove it for reads later |
| R-2 | Errors (DV-548): `Symbol.hasInstance` on the context's `Error` family, keeping the server's object, or re-create them as Convex does | **`hasInstance`.** It is cheaper, and the engine keeps its own error |
| R-3 | `"use node"` actions (DV-547): keep the server's realm, matching the packages they use, or convert | **Keep the server's realm.** Converting would make app data foreign to the packages, which is worse than today |
| R-4 | Web APIs (`TextEncoder`, `crypto`, `Blob`, `Request` bodies) returning host objects | **A follow-up study.** Bun's `vm` has no web APIs of its own; each needs a wrapper or a realm-aware copy |
| R-5 | Order | **First the other direction (a bug, §3 item 3), then A with the probe and the errors, then R-4** |

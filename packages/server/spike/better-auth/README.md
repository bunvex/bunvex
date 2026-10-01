# Spike: better-auth hosted in the engine (STUDY-28 §3.8 step 0)

Branch-only: never merged. `bun packages/server/spike/better-auth/run.ts` writes `RESULTS.txt`.

- **Setup:** better-auth 1.7.6 (`better-auth/minimal`, no Kysely), with plugins `emailAndPassword`,
  `admin` and `jwt` (ES256).
- **Persistence:** in memory.
- **The adapter** (`adapter.ts`) uses the current bunvex `Tx` from an AsyncLocalStorage. Outside an
  execution, each call is its own query or mutation, and `transaction(cb)` is one engine mutation.
- **The dispatcher** (`call` in `run.ts`) runs one endpoint per execution.
- **Engine change for the spike:** `withRealCrypto` in `packages/core/src/determinism.ts` (B5).

## Results (M-series laptop, load ~2)

| Experiment | Result |
|---|---|
| Sign-up without the B5 exception | **fails**: `crypto.getRandomValues()` in a mutation (ids, tokens, salts) |
| Sign-up in one mutation | ✓ 55 ms; user + account + session + verification-email outbox row, atomically |
| Sign-in in one mutation | ✓ 54 ms; sets `better-auth.session_token` |
| Cost breakdown | scrypt alone is 53 ms; everything else (all adapter calls, in-process) ~2 ms |
| `getSession` in a **query** | ✓ p50 0.28 ms, p99 1.7 ms (×200). The Convex component reports 100–360 ms |
| Failure injected after the user row | ✓ nothing left behind (users before = after; no outbox row) |
| 20 concurrent distinct sign-ups | ✓ 20 ok, 199 ms total, 0 OCC retries (scrypt runs off the JS thread; 20 hashes in parallel take 227 ms) |
| 10 concurrent sign-ups of one email | ✓ exactly 1 user; 9 OCC retries, each ending in "User already exists" |
| admin `listUsers` with a `contains` search, in a query | ✓ 2–4 ms |
| admin `banUser` (mutation) | ✓ the banned user's `getSession` is null at once; their sign-in is refused |
| jwt `getToken` | ✓ ES256, `sub` = user id, 15 min; works in a query once a key exists |
| The same endpoint from an action (the OAuth path) | ✓ `signUpEmail` wraps its body in `transaction()`, which becomes one engine mutation; an injected failure leaves nothing |

## Findings (they feed back into STUDY-28)

1. **B5 is required, and it is enough.** With the real CSPRNG in the auth executions, nothing else in
   these flows breaks determinism inside mutations. That includes `Date`, AsyncLocalStorage nesting,
   async scrypt and WebCrypto.
2. **The jwt plugin creates its first key pair lazily, during a read** (the hook on `/get-session`
   encrypts the new private key, so the query hit `getRandomValues`). It is the write-on-read that issue
   #6215 reports. **Fix:** the deployment creates its signing key at startup, in a mutation (done in the
   spike). Rotation also has to be explicit (a mutation), never on a read.
3. **`getSession` is not deterministic as a full response.** The jwt plugin's hook signs a fresh
   `set-auth-jwt` token on every call; ECDSA uses a random nonce and `iat` changes. The body is
   identical. **Fix:** the session query returns the body only, and tokens are issued only by the token
   mutation (`getToken`). The hook is turned off or its header dropped.
4. **`deferSessionRefresh: true` makes `getSession` read-only.** Nothing tried to write from the query;
   the adapter refuses writes from queries, and that check never fired.
5. **Atomicity holds on both paths:** endpoint-in-a-mutation, and endpoint-in-an-action through
   `transaction()`. The in-process closure is what makes the second possible; the Convex component cannot
   do it.
6. **OCC is a good fit.** Contention on one email serializes correctly. Each retry re-hashes (about
   50 ms), which is acceptable for a rare case; if needed, the hash can be computed before the
   transaction.
7. **The email outbox pattern works.** `sendVerificationEmail` inserts an `outbox` row in the same
   transaction, and an action (the scheduler) delivers it after commit. `backgroundTasks.handler` is the
   wrong hook: its promise has already started inside the transaction.

## Not covered (next)

- OAuth (a fake provider + HTTP callback), which needs HTTP actions.
- Real persistence (Postgres/SQLite) latency.
- The sync-session revocation (B3).
- The client transport (`customFetchImpl`).
- Plugin manifests.
- The `organization`, `two-factor` and `passkey` plugins.

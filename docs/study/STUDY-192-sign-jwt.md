# STUDY-192 — `ctx.auth.signJwt` and the deployment JWKS
<!-- index: `ctx.auth.signJwt` in mutations and `/.well-known/jwks.json`: ES256 tokens signed by a key derived from the instance secret, so a store the Convex binary wrote serves the same keys; the claim rules, limits and errors; the first prerequisite of built-in auth (STUDY-191) | accepted: S-1–S-3 as recommended (DV-578, DV-579); built (PR 1), the JWKS byte-identical to Convex's for the same secret -->

- **Status:** accepted: S-1–S-3 as recommended (owner, 2026-10-26; DV-578, DV-579). Built (2026-10-27): §3.6 PR 1,
  tested as §5 (the JWKS metrics, PR 2, not yet).
- **Convex source read:** convex/convex-backend `origin/main` on 2026-10-26:
  - the runtime commits `76fe874` (the syscall and the keys), `aafa4d8` (the JWKS route), `2c4c29f` (1 h maximum
    lifetime), `f34ac10` (`sub` must be a string), `74a65e0` (a missing key is an internal error) and `72e88b8`
    (the `nbf` wording);
  - `fc49e41`, which reserved `jti`, reverted by `7d37097`;
  - the client: `3d06153` reverted by `1de00b1`, reapplied as `ebbb92c`;
  - the changelog, `f068c0e`;
  - `900eba4`, metrics on JWKS responses, which is verification-side;
  - all listed in [STUDY-186](STUDY-186-convex-after-72ce13c.md) §4.2.
- **Related:**
  - [STUDY-191](STUDY-191-convex-auth-v2.md), built-in auth, whose core mints its tokens this way;
  - [STUDY-27](STUDY-27-auth.md), how bunvex verifies `customJwt` tokens;
  - [STUDY-34](STUDY-34-admin-keys.md) and [STUDY-17](STUDY-17-paginate.md), the instance secret and its KBKDF;
  - [STUDY-49](STUDY-49-canonical-urls.md), canonical URLs;
  - [STUDY-168](STUDY-168-process-sandbox.md), the process sandbox;
  - [STUDY-186](STUDY-186-convex-after-72ce13c.md) Q1, the reserved claim prefixes (decided).

## 1. How Convex does it

### 1.1 The API

`npm-packages/convex/src/server/authentication.ts`:

- **`MutationAuth extends Auth`** adds `signJwt(options: SignJwtOptions): Promise<string>`.
  - `MutationCtx.auth` is a `MutationAuth` (`registration.ts`).
  - Queries and actions keep `Auth`, which has no `signJwt`. A mutation an action calls with `runMutation` has
    it.
- **`SignJwtOptions = { claims?: SignJwtClaims; expiresInSeconds: number }`.**
- **`SignJwtClaims`** is `Record<string, JSONValue>` with:
  - `iss`, `iat`, `exp` and `nbf` typed `never` (`ReservedJwtClaim`);
  - any name starting with `convex` or `cvx`, in every ASCII casing, typed `never` (`ReservedJwtClaimPrefix`,
    built with a type `AnyCase<S>`).
- **Exports** from `convex/server`: `MutationAuth`, `ReservedJwtClaim`, `ReservedJwtClaimPrefix`, `SignJwtClaims`,
  `SignJwtOptions`.
- **The implementation** (`impl/authentication_impl.ts`, `setupMutationAuth`) is one async syscall,
  `1.0/signJwt`, with `{requestId, version, claims?, expiresInSeconds}`.
- **The doc comment** says:
  - the `iss` is `CONVEX_CLOUD_URL` for the app and `${CONVEX_CLOUD_URL}/components/<name>` for a component;
  - the keys are at `${CONVEX_CLOUD_URL}/.well-known/jwks.json`;
  - claims are signed, not encrypted;
  - prefer short lifetimes, since a token cannot be revoked; the maximum is 1 h.

### 1.2 The syscall

`crates/isolate/src/environment/udf/async_syscall.rs`, `sign_deployment_jwt`.

1. **Only in a mutation.** Anything else fails with the bad request `JwtSignInQuery`, "ctx.auth.signJwt() can't be
   called from a query. Call it from a mutation." The comment explains why: a token holds the current time, and
   the query cache could serve it again. Only a raw syscall reaches this, because a query's `ctx.auth` has no
   `signJwt`.
2. **The origin** (`crates/udf/src/deployment_jwt.rs`, `deployment_origin`): the canonical `CONVEX_CLOUD_URL`
   override, read in the transaction (`system_env_var_overrides`), else the default system variable.
3. **The signer** is the calling function's component path (`tx.get_component_path(component)`).
4. **The keys** come from the key broker. A runner that did not receive them fails with an internal error
   (`74a65e0`).
5. **The time** is the execution's timestamp (`provider.phase.unix_timestamp()`), the one the mutation's
   `Date.now()` sees.
6. **Parsing** (`mint` in `crates/udf/src/deployment_jwt.rs`).
   - `claims` defaults to `{}`.
   - `expiresInSeconds` must be a finite number ≥ 1, else the bad request `InvalidArguments`, "Invalid arguments
     for auth.signJwt: expiresInSeconds must be a number of seconds, at least 1".
   - A malformed argument object gets the same code with serde's message.
   - The value is then truncated to whole seconds (`as u64`), so `1.9` signs for 1 s.

### 1.3 Minting

`crates/keybroker/src/deployment_jwt.rs`, `DeploymentJwtKey::mint`. Every check is the bad request
`InvalidJwtRequest`, in this order:

1. `iss`, `iat` or `exp` present: "The '<name>' claim is set by Convex and can't be provided".
2. A name whose first bytes match `convex` or `cvx`, ASCII case-insensitive: "The '<name>' claim can't be provided:
   claim names starting with 'convex' or 'cvx' are reserved".
3. `sub` present but not a non-empty string: "The 'sub' claim must be a non-empty string" (`f34ac10`; a
   `customJwt` provider refuses a non-string `sub`).
4. `nbf` present: "The 'nbf' claim is reserved by Convex and can't be provided" (`72e88b8`).
   - `jti` is not reserved: `fc49e41` reserved it and `7d37097` reverted that.
5. The lifetime is 0 or above `DEPLOYMENT_JWT_MAX_LIFETIME`: "expiresIn must be between 1 second and 3600 seconds".
   - The knob is `DEPLOYMENT_JWT_MAX_LIFETIME_SECONDS`, default 3600 (`2c4c29f` lowered it to 1 h).

**The token.**
- **Claims:**
  - `iss` from `deployment_jwt_issuer(origin, signer)`: the origin without a trailing `/` for the root,
    `{origin}/components/{path}` for a component;
  - `iat` as whole seconds;
  - `exp = iat + lifetime`;
  - the caller's claims, which are any JSON.
- **Header:** `{"alg":"ES256","typ":"JWT","kid":<kid>}`.
- **Signature:** ECDSA P-256 over SHA-256, fixed-width (r‖s, 64 bytes), with random nonces, so two tokens with the
  same claims differ. Each part is base64url without padding.
- **Size:** a token over 8000 bytes (`DEPLOYMENT_JWT_MAX_SIZE`) fails: "The token is <n> bytes, over the 8000 byte
  limit".

### 1.4 The keys

`DeploymentJwtKeys`, in the same file. They are derived on demand and nothing is stored.

1. **The root.** `root = KBKDF-CTR-HMAC-SHA256(instance secret, "deployment jwt signing root", 32 bytes)`
   (`derive_bytes` in `encryptor.rs`). It is the same KBKDF Convex uses for the admin key, cursors and the other
   purposes.
2. **One key per generation.** `private = KBKDF(root, "deployment jwt signing key" ‖ generation (u32 BE) ‖
   attempt (u8), 32 bytes)`, for attempt 0 to 255.
   - The first scalar that is a valid P-256 private key wins; about 1 in 2^32 is out of range.
   - The public point is computed from the scalar.
3. **Which generation.** Only `SIGNING_GENERATION = 0` signs and is published. The scheme leaves room for rotation
   without stored key material.
4. **`kid`** is the RFC 7638 thumbprint: base64url of SHA-256 over `{"crv":"P-256","kty":"EC","x":…,"y":…}`.
5. **The JWKS** is one key: `{"kty":"EC","crv":"P-256","x","y","use":"sig","alg":"ES256","kid"}`.
6. **A function runner** that never sees the secret gets the 32 root bytes (`from_root_key_bytes`).

So the keys are a pure function of the instance secret. The same secret gives the same JWKS on any backend.

### 1.5 The JWKS route

`crates/local_backend/src/deployment_jwks.rs` and `router.rs`:

- **The route:** `GET /.well-known/jwks.json` on the API origin, beside `/api`, inside the CORS layer.
- **The answer:** the JWKS as JSON, with `Cache-Control: public, max-age=<DEPLOYMENT_JWKS_MAX_AGE>`.
  - The knob is `DEPLOYMENT_JWKS_MAX_AGE_SECONDS`, default 300.
- **No authentication.**

### 1.6 Verifying these tokens

Convex has no shortcut. A deployment that accepts its own tokens lists a `customJwt` provider in `auth.config.ts`:
- `issuer: ${CONVEX_CLOUD_URL}[/components/<path>]`;
- `jwks: ${CONVEX_CLOUD_URL}/.well-known/jwks.json`;
- `algorithm: "ES256"`.

It then fetches its own JWKS over HTTP like any other provider, cached by `Cache-Control`. Convex Auth v2 does
exactly this (STUDY-191 §1.4). `900eba4` only adds verification metrics: JWKS body size and key count, and the
algorithms seen in JWKS keys and JWT headers.

## 2. What an app can observe

1. **Where it exists.**
   - `ctx.auth.signJwt` exists in mutations, including a component's and one called by an action.
   - It does not exist in queries or actions. Calling it there is a `TypeError`, since the method is missing.
2. **What the token contains.** Each claim the caller passed, plus:
   - `iss`: the canonical cloud URL, or the server's own, plus `/components/<path>` in a component;
   - `iat`: the mutation's time, in whole seconds;
   - `exp = iat + floor(expiresInSeconds)`.
3. **The header and the algorithm:** ES256, `typ: "JWT"`, `kid` the key's thumbprint.
4. **The refusals:** each of §1.2–§1.3, with its code and message, thrown in the mutation.
5. **The JWKS.**
   - It is served at `/.well-known/jwks.json` with the cache header.
   - It is **the same keys for the same instance secret**, so a store the Convex binary wrote serves the JWKS
     Convex served.
   - A token signed by either backend verifies against the other's JWKS.
6. **Verification:** a `customJwt` provider pointing at the deployment accepts its tokens through the existing
   verifier (STUDY-27).
7. **Not observable:**
   - the signature bytes, which are random per token;
   - the order of the claims inside the payload;
   - how the key is cached.

## 3. How bunvex does it

### 3.1 The keys (`packages/core`)

**A new module, `packages/core/src/deployment-jwt.ts`, derives the keys.**
- The root comes from `engine.derivedKey("deployment jwt signing root", 32)`. The engine already derives Convex's
  per-purpose keys with this KBKDF (`packages/core/src/kbkdf.ts`, `engine.ts` `derivedKey`).
- Each generation's scalar is `kbkdfCtrHmacSha256(root, label ‖ u32BE(gen) ‖ u8(attempt), 32)`.
- The P-256 key is built from the scalar with `node:crypto`:
  - `createECDH("prime256v1").setPrivateKey(d)` gives the public point, and refuses an out-of-range scalar, which
    is the cue to try the next attempt;
  - the point and scalar become a JWK `KeyObject`;
  - signing is `crypto.sign("sha256", input, {key, dsaEncoding: "ieee-p1363"})`.
- The key is computed once per instance secret and cached on the engine.

**The minting function** takes `{origin, signer, claims, expiresIn, now}` and applies §1.3's checks in Convex's
order. It is pure apart from the signature's randomness.

### 3.2 `ctx.auth.signJwt` (`packages/server`)

- **Where.** A mutation's context gets `auth: {getUserIdentity, signJwt}`, next to `txAuth` in
  `packages/server/src/functions.ts`. Queries keep `txAuth`. Actions keep their `Auth`.
- **The origin:** `readCanonicalUrls(db).cloud ?? builtinEnv.BUNVEX_CLOUD_URL`, read in the transaction as
  Convex does. A mutation that signs therefore depends on the canonical URL row, which is correct.
- **The signer:** the component the function runs in (the runtime's `path`); the root is the app.
- **The time:** the execution's frozen clock (`packages/core/src/determinism.ts`), the time the mutation's
  `Date.now()` returns.
- **The process sandbox.** With `BUNVEX_FUNCTION_SANDBOX=process` (AD-44), the child asks the host to sign, as it
  does for its other `ctx` operations (STUDY-168, STUDY-171). The key never enters the child. Convex sends the
  root bytes to its function runner; bunvex has no reason to.
- **The types** in `bunvex/server`: `MutationAuth`, `SignJwtOptions`, `SignJwtClaims`, `ReservedJwtClaim` and
  `ReservedJwtClaimPrefix`, with Convex's names (none contains "convex"), and `MutationCtx.auth: MutationAuth`.
  - The reserved prefixes stay `convex` / `cvx` in the type (STUDY-186 Q1). Those strings are type-level data and
    a check, the same exception as the runtime check (S-1).
- **The knobs** keep Convex's names, as bunvex's other knobs do (`knob("HTTP_CACHE_SIZE")`):
  `DEPLOYMENT_JWT_MAX_LIFETIME_SECONDS` (3600) and `DEPLOYMENT_JWKS_MAX_AGE_SECONDS` (300).

### 3.3 The route

- **The route:** `GET /.well-known/jwks.json` on the API origin, beside `/instance_version` (`health.ts`).
- **CORS:** inside the CORS layer (`cors.ts`), so a browser verifier can read it.
- **The answer:** `Cache-Control: public, max-age=300`, the body the JWKS.
- **No authentication.**

### 3.4 Verification

- **Nothing changes in the verifier.** A `customJwt` provider pointing at the deployment fetches
  `/.well-known/jwks.json` over HTTP, caches it by `Cache-Control` (STUDY-27) and accepts ES256, as Convex does.
- **Loopback is reachable.** bunvex's outbound screening (AD-15) denies only the metadata range by default, so a
  local deployment can fetch its own JWKS.
- **A local shortcut is a later addition.** Verifying the built-in issuer without HTTP is one of STUDY-191 §3.7's
  later additions, not part of this study.

### 3.5 Metrics

`900eba4`'s JWKS metrics belong with the verifier. They follow the metrics parity rows (`platform.md` §20) in the
PR that builds this, or in a small PR of their own. They are not a prerequisite of auth.

### 3.6 PRs

1. **Keys, minting, the route and `ctx.auth.signJwt`**, with:
   - unit tests of every rule;
   - a sabotage check, for example dropping the `nbf` refusal and watching its test fail;
   - the differential tests of §5.
2. **Optionally**, the JWKS metrics (§3.5).

The differential tests need an oracle with `signJwt`, Convex's release of 2026-10-15 or later. The oracle is
still `precompiled-2026-10-10-72ce13c`. bunvex-c6 moves it to `precompiled-2026-10-26-04d2f3b` in STUDY-193, so
PR 1 waits for that move or ships its differential tests with it.

## 4. Divergences

| # | Divergence | Recommendation | Why | Decision |
|---|---|---|---|---|
| S-1 | Messages that name Convex ("is set by Convex", "is reserved by Convex") use bunvex's words: "is set by the deployment", "is reserved by the deployment". The reserved prefixes stay `convex` and `cvx`, at runtime and in the types (STUDY-186 Q1, already decided) | **Yes** | Rule 5 on messages. The prefixes are kept for apps that move between the two | **Yes** (owner, 2026-10-26; DV-578) |
| S-2 | Also reserve a `bunvex` claim prefix | **No**, not until bunvex sets a claim of its own | Convex's apps may set `bunvexFoo`; reserving it is a divergence with no use today. STUDY-191's later additions can ask again if they need one | **No** (owner, 2026-10-26; matches Convex) |
| S-3 | The process sandbox signs in the host, never giving the child the key (Convex sends the root bytes to its runner) | **Yes** | Not observable; it keeps key material out of sandboxed app code | **Yes** (owner, 2026-10-26; DV-579) |

`JwtSignInQuery`, `InvalidJwtRequest` and `InvalidArguments` keep Convex's codes, since none contains "convex".

## 4b. Additions

None.

## 5. Tests

- **Unit** (`packages/core`):
  - each refusal of §1.2–§1.3, with its message and order;
  - the reserved prefixes in any casing (`CvXfoo`, `CONVEXbar`), and a name with a multibyte first character;
  - `sub` as `""`, a number, `null`;
  - lifetimes 0, 0.5, 1, 1.9 (signs for 1 s), 3600, 3601, `NaN`, `Infinity`;
  - the 8000-byte limit at its edge;
  - `kid` against RFC 7638's example;
  - key derivation against a fixed secret, with the expected JWKS written in the test.
- **Server:**
  - `signJwt` in a mutation, in a component's mutation (the `iss` path), in a mutation called by an action, and
    absent in queries and actions;
  - the canonical URL in `iss`;
  - `iat` equal to the mutation's `Date.now()` in seconds;
  - the process sandbox, the same results;
  - the route's headers and CORS.
- **End to end:** an `auth.config.ts` `customJwt` provider pointing at the deployment accepts a token the
  deployment signed, over the sync protocol and HTTP.
- **Differential** (`packages/differential`, against Convex's binary, once the oracle has `signJwt`):
  - the same instance secret gives the **byte-identical JWKS** and the same `kid`;
  - a token from either verifies with the other's JWKS;
  - claims, header and errors match (the error surface in the mutation pinned on both);
  - a store the Convex binary wrote, opened by bunvex, serves the same JWKS.

## 6. Open questions

- **How the error reaches the mutation** (answered by the differential test). A refusal is a plain `Error` with the
  message, which a mutation can catch; uncaught, it is `Uncaught Error: <message>` with **no frame** of the app's:
  Convex raises it in its syscall. bunvex strips the app's frames from the error it throws (`functions.ts`
  `mutationAuth`).
- **Not compared:** a claim value that JSON cannot carry (a `bigint`): Convex's client fails in `JSON.stringify` with
  V8's message, bunvex with Bun's.

## 7. As built

- **`packages/core/src/deployment-jwt.ts`:** the keys (KBKDF root, per-generation scalars, the in-range retry), the
  thumbprint, `mint` with §1.3's checks and `parseSignJwtArgs` with §1.2's, serde's messages included
  (`missing field \`expiresInSeconds\``, `invalid type: …, expected f64` / `a map`). The JWK's fields are in
  `biscuit`'s order (`use`, `alg`, `kid`, `kty`, `crv`, `x`, `y`), which is what makes the JWKS byte-identical.
- **`packages/server`:** `ctx.auth.signJwt` on a mutation's context (`functions.ts` `mutationAuth`);
  `DEPLOYMENT_JWT_MAX_LIFETIME_SECONDS`; `GET /.well-known/jwks.json` (`health.ts` `jwksRoute`, under the API's CORS)
  with `DEPLOYMENT_JWKS_MAX_AGE_SECONDS`; the types `MutationAuth`, `SignJwtOptions`, `SignJwtClaims`,
  `ReservedJwtClaim`, `ReservedJwtClaimPrefix`.
- **`packages/sandbox`:** the `auth.signJwt` operation, mutations only; the child sends the options as JSON and the
  host signs (DV-579).
- **Tests:**
  - `packages/core/test/deployment-jwt.test.ts`: every refusal and its order, the prefixes in any casing, `sub`,
    lifetimes, the 8000-byte edge, the thumbprint, a pinned JWKS for a fixed secret, verification and forgery;
  - `packages/server/test/sign-jwt.test.ts`: the mutation's token (`iat` its `Date.now()`), the canonical URL, queries
    and actions without `signJwt` and a mutation an action runs with it, the refusals, the lifetime knob, the route;
  - `packages/testing/test/sign-jwt.test.ts`: the app's and a component's token, in-process and under the process
    sandbox;
  - `packages/differential/test/sign-jwt.test.ts`, with one instance secret on both: the JWKS byte for byte, the
    header and claims (and their order), cross-verification, the component's `iss`, and 14 refusals caught and
    uncaught, word for word apart from DV-578.
  - Sabotage checks: the `nbf` refusal (core), and the child's `signJwt` (the sandbox test).

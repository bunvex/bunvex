# STUDY-34 — Admin keys and admin access

- **Status:** draft
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend.
- **Crypto checked.** The key cryptography was checked against `aws-lc-rs` 1.18.1, the library and version
  Convex's keybroker uses, with a small Rust harness (§5). Building `generate_key` itself pulls Convex's V8
  fork.
  - A JS prototype of KBKDF and AES-128-GCM-SIV produced the same derived key and the same sealed key bytes.
  - It also passes the RFC 8452 vectors.
- **Related:**
  - [STUDY-27](STUDY-27-auth.md): user auth; A4 names the admin scheme `Bunvex`.
  - [STUDY-26](STUDY-26-sync-client.md) H2 (DV-97): `Authorization: Bunvex <key>`.
  - [STUDY-28](STUDY-28-builtin-auth.md) B9: dashboard user management through `_system/auth:*` with the
    admin key.
  - [STUDY-12](STUDY-12-dashboard.md) §1.5 and [UI-01](../specs/UI-01-ui-and-dashboard.md) §5.7: the
    dashboard's admin data source.
  - [platform §2](../parity/platform.md#2-deployment-auth-admin-keys-operations).

Paths are relative to `crates/` unless stated.

## 1. How Convex does it

### 1.1 The key

**Format.** An admin key is `"{instance name}|{hex}"` (`common/src/types/admin_key.rs:147-153`).

**Prefixes.** A type prefix is cosmetic and is stripped by everything up to the first `:`
(`remove_type_prefix_from_deployment_name`, :165). Examples are `prod:name|…` and `dev:name|…`, which
the CLI and dashboard add. `preview:team:project|…` and `project:…|…` keep only the key part, and so does
a bare hex key with no name.

**The hex part** is `version (1) ‖ nonce (12) ‖ ciphertext ‖ tag (16)` (`keybroker/src/encryptor.rs:90-120`):

- `version` is `ADMIN_KEY_VERSION = 1`, and it is also the AEAD's associated data.
- The cipher is **AES-128-GCM-SIV** with a random nonce.
- Its key is derived from the 32-byte instance secret by **KBKDF in counter mode with HMAC-SHA256** and
  the purpose `"admin key"` (16 bytes).
- The plaintext is the protobuf `AdminKey` (`pb/protos/convex_keys.proto:7-16`):
  `instance_name = 1` (left empty by new keys), `issued_s = 2`, `oneof identity { member_id = 3; Empty system = 4 }`
  and `is_read_only = 5`.

Keys made with the old libsodium secretbox are still accepted (`legacy_encryptor.rs`) and logged.

**Issuing** (`broker.rs:979-1026`) has three entry points:

- `issue_admin_key(member_id)`;
- `issue_read_only_admin_key`, which is cloud only: self-hosted cannot make one;
- `issue_system_key()`, with `identity = System`.

Self-hosted ships `generate_key <instance_name> <secret_hex> [--member-id N] [--system-key]`
(`keybroker/src/bin/generate_key.rs`). It prints "Admin key:" on stderr and the key on stdout. The docker
image's `generate_admin_key.sh` reads the credentials first:

- `INSTANCE_SECRET`, else `$DATA_DIR/credentials/instance_secret`, else a new `openssl rand -hex 32`, then
  persisted;
- `INSTANCE_NAME`, else `convex-self-hosted`, then persisted.

**Checking** (`check_admin_key`, broker.rs:1041-1091) runs these steps:

1. It decrypts the key; failure gives "Couldn't decode the AdminKeyProto".
2. It takes the instance name from the prefix, else from the proto ("Invalid admin key format").
3. A name that is not this instance's is refused ("Key is for invalid instance {name}").
4. It requires `issued_s` and an identity. There is **no expiry**: a key works until the instance secret
   changes.

A member key becomes `Identity::DeploymentAdmin(AdminIdentity { is_read_only, allowed_ops, validated_at, … })`,
and a system key becomes `Identity::System`.

**Allowed operations** (`operations.rs:131-155`):

- A full key has `allowed_ops = []`, which means every operation.
- A read-only key has the `View*` operations plus `DownloadBackups`, `RunInternalQueries` and
  `RunTestQuery`.
- Read-only is enforced only through operations, so a read-only admin can still call a public mutation, as
  anyone can.
- An *identity* (not the key) expires after `ADMIN_IDENTITY_EXPIRATION_DELAY` (2000 s); the sync worker
  revalidates it from the stored key.

`DeploymentOp` (`operations.rs`) has 26 members:

- deployment: `Deploy`, `PauseDeployment`, `UnpauseDeployment`;
- environment variables: `ViewEnvironmentVariables`, `WriteEnvironmentVariables`;
- logs, metrics and integrations: `ViewLogs`, `ViewMetrics`, `ViewIntegrations`, `WriteIntegrations`;
- data: `ViewData`, `WriteData`;
- backups: `ViewBackups`, `CreateBackups`, `DownloadBackups`, `DeleteBackups`, `ImportBackups`;
- functions: `ActAsUser`, `RunInternalQueries`, `RunInternalMutations`, `RunInternalActions`,
  `RunTestQuery`;
- the rest: `ViewAuditLog`, `ViewUsage`, `ViewUsageLimits`, `WriteUsageLimits`, `UseAiGateway`.

### 1.2 Presenting a key

**HTTP.** A key travels in the header `Authorization: Convex <key>`, where the scheme is case-insensitive
and any other scheme is a Bearer JWT. Without a header it can travel as `?adminKey=<key>`
(`local_backend/src/authentication.rs:43-95`).

**Acting as a user.** `<key>:<base64(JSON UserIdentityAttributes)>` acts as that user (`ActingUser`;
:170-205). It is refused for a system key.

**Sync.** The message is `Authenticate { tokenType: "Admin", value, baseVersion, impersonating? }`, and
`actingAs` is accepted too (`convex/sync_types/src/types/json.rs:161-171`). A bad key closes the socket
with `AuthError { authUpdateAttempted: false }`.

**Errors.** They are mapped in `application_auth.rs:31-75`, `operations.rs:118-129` and
`roles/src/eval.rs:280-300`:

| Case | Status | Code | Message |
|---|---|---|---|
| A key that does not decrypt, or is for another instance | 401 | `BadAdminKey` | "The provided admin key was invalid for this instance" |
| No key (or a user) where an admin is required | 403 | `BadDeployKey` | "The provided deploy key was invalid for deployment '{name}'. Double check that the environment this key was generated for matches the desired deployment." |
| An admin without the operation | 403 | `OperationNotPermitted` | "You do not have permission to perform this operation ({action})." |
| An unreadable header | 400 | `InvalidHeaderFailure` | "Malformed Authorization header." |

### 1.3 What an admin may do

**Functions** (`udf/src/validation.rs:259-312`, `check_visibility_access`):

- **Internal functions:** callable by an admin, a system identity or an acting user, needing
  `RunInternalQueries`, `RunInternalMutations` or `RunInternalActions`. Anyone else gets "Could not find
  public function for '…'."
- **`_system/*` functions:** callable only by an admin or a system identity; to others they do not exist.
  Each one also asks for its operation (`requireOperation`, `system-udfs/convex/_system/server.ts:77`). The
  ones bunvex has need `ViewData` for the schedule, cron and file queries, and `WriteData` for the file
  mutations.
- **Acting as a user** needs `ActAsUser`.
- **The identity inside a function:** `ctx.auth.getUserIdentity()` is **null for an admin**
  (`database/src/transaction.rs:378-384`) and the user's attributes for an acting user. The query cache keys
  an admin by instance and operations, and an acting user as that user.

**Endpoints** (router.rs, dashboard.rs, scheduling.rs):

| Endpoint | Requires |
|---|---|
| `GET /api/check_admin_key` | an admin or acting user. Returns `{"success": true, "allowedOps": [...], "isReadOnly": bool}` (`[]` means all) |
| `POST /api/cancel_job` `{id, componentId?}` | `WriteData` |
| `POST /api/cancel_all_jobs` `{componentId?, componentPath?, udfPath?, startNextTs?, endNextTs?}` | `WriteData` |
| push, config, environment variables, logs, metrics, import and export | each their own operation; they come with those features |
| `/instance_name`, `/instance_version`, `/` | nothing |

**The dashboard** takes the key from its login form (or `NEXT_PUBLIC_ADMIN_KEY`) and keeps it in
`sessionStorage`. It checks the key with `GET /api/check_admin_key`, where a 404 is read as "all
operations". The CLI uses `CONVEX_SELF_HOSTED_URL` with `CONVEX_SELF_HOSTED_ADMIN_KEY`.

**Audit and rate limits.** There is no rate limit on key checks. Admin writes are recorded in the deployment
audit log; reads are not.

## 2. What an app (and an operator) can observe

1. **A key works across implementations.** A key issued by Convex for an instance name and secret checks
   out on any implementation with the same name and secret, and the reverse: the format is fixed by the
   bytes. The validity rules (the instance name, no expiry, prefixes stripped) and the errors and codes above
   are what a client sees.
2. **As an admin,** the client can call internal functions and `_system/*` functions, act as a user, and
   read `check_admin_key`. Without a key, none of them exist.
3. **Inside a function,** an admin is anonymous (`getUserIdentity()` returns null), and an acting user is
   that user.

## 3. How bunvex does it

### 3.1 What exists

- **Clients.** They already send admin auth, as DV-97 decided: `setAdminAuth` in sync, and
  `Authorization: Bunvex <key>[:<b64 identity>]` over HTTP.
- **Server.** It refuses both today:
  - sync: "Admin keys are not supported yet";
  - HTTP: 401 `Unauthenticated`.
- **Instance secret.** It comes from the option `instanceSecret`, else it is generated and stored in
  `_instance` (DV-07).
- **No instance name.**
- **System functions** (schedules, crons, files) are reachable only in process: `runSystemQuery`,
  `runSystemMutation`. So are the job cancellations.
- **Internal functions** cannot be reached from outside.
- **`/stats`**, a bunvex-only endpoint, has no gate.
- **The CLI** is an empty package.

### 3.2 The design

**Keys** live in `@bunvex/server` (`admin-keys.ts`):

- **The format,** byte for byte:
  - `name|hex(1 ‖ nonce ‖ AES-128-GCM-SIV(AdminKey proto) ‖ tag)`, with the KBKDF-derived key.
  - Bun has AES-GCM but not AES-GCM-SIV, so GCM-SIV is written from RFC 8452 over `aes-128-ecb`: the
    POLYVAL hash, the tag and CTR mode. A key is a few dozen bytes, and a checked key is cached by its
    string, so the cost is one decryption per new key.
  - The `AdminKey` proto is encoded and decoded by hand (five fields).
- **Two functions:**
  - `issueAdminKey({ instanceName, instanceSecret, readOnly?, system? })`;
  - `checkAdminKey(key)`, which returns an `AdminIdentity`, a system identity, or throws Convex's
    `BadAdminKey`.
  - Type prefixes are stripped as Convex strips them.
- **Tests:** the RFC 8452 vectors, plus keys from Convex's `generate_key` checked by bunvex and the
  reverse.

**The instance name:**

- It comes from the option `instanceName` and `INSTANCE_NAME`.
- Otherwise it is stored in `_instance` next to the secret, set once to the default (AK2).
- It is served at `GET /instance_name`.

**Identities.** The server's caller becomes one of four:

| Identity | What it is |
|---|---|
| none | |
| user | a verified JWT |
| admin | `{ readOnly, allowedOps }` |
| acting user | an admin plus the user's attributes |
| system | from a system key |

- An admin is anonymous to `getUserIdentity()`.
- Query cache keys and sync's shared executions key an admin by its operations, as Convex's cache does.

**Presenting a key:**

- **HTTP:** `Authorization: Bunvex <key>[:<b64 attributes>]` (DV-97), or `?adminKey=` when there is no
  header. The errors are Convex's: 401 `BadAdminKey`, 403 `BadDeployKey`, 403 `OperationNotPermitted`.
- **Sync:** `Authenticate { tokenType: "Admin", value, impersonating | actingAs }`. A bad key gets
  `AuthError` and the socket closes.

**Function access:**

- Internal functions are open to an admin with `RunInternal*`.
- `_system/*` functions go through `/api/query`, `/api/mutation`, `/api/query_at_ts` and sync for an admin
  (the `SYSTEM_QUERIES` / `SYSTEM_MUTATIONS` tables, each entry with its operation: `ViewData` or
  `WriteData`). To anyone else they do not exist.
- Acting as a user needs `ActAsUser`.

**Endpoints:**

- `GET /api/check_admin_key`;
- `POST /api/cancel_job` and `POST /api/cancel_all_jobs` (`WriteData`, over the existing
  `cancelScheduledJob` / `cancelAllScheduledJobs`);
- `GET /instance_name`;
- `/stats`, gated by an admin key (AK5).

**Issuing a key.** The first `@bunvex/cli` command (AK3):

- `bunvex admin-key [--read-only] [--system]` prints a key.
- It takes the instance name and secret from `INSTANCE_NAME` / `INSTANCE_SECRET` or from flags.
- Otherwise it reads them from the store's `_instance`, opened for reading only, without the lease, so it
  works while the server runs.
- The library function is exported for hosts that issue keys themselves.

### 3.3 PRs

1. **The keys:**
   - `admin-keys.ts` (GCM-SIV, KBKDF, the proto, issue and check);
   - the instance name;
   - `/instance_name`;
   - vectors from Convex's binary.
2. **Admin access:**
   - the identities;
   - HTTP and sync parsing;
   - internal and system functions with their operations, and acting as a user;
   - `check_admin_key`, `cancel_job`, `cancel_all_jobs`, and the `/stats` gate.
3. **`bunvex admin-key`,** the read-only open of `_instance`.
4. **Parity rows:**
   - platform §2;
   - client-sync's Admin rows;
   - the schedule and cron rows ("reachable once admin keys exist");
   - STUDY-27, and DV-11.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| AK1 | Only the current key format is accepted: keys sealed with the old libsodium secretbox (Convex's legacy format, still accepted and logged) are refused with `BadAdminKey` | bunvex never issued them, and Convex's own self-hosted image has issued the current format for a long time. A legacy key holder generates a new one | pending |
| AK2 | The default instance name, when `INSTANCE_NAME` is not set, is `bunvex-self-hosted` (Convex: `convex-self-hosted`). It is stored in `_instance` next to the generated secret, where Convex keeps both in its credentials directory | rule 5 (no "convex" in shipped strings). `_instance` is where DV-07 already keeps the secret. A Convex key works on bunvex when `INSTANCE_NAME=convex-self-hosted` is set with the same secret | pending |
| AK3 | Keys are issued by `bunvex admin-key` (CLI), which reads the credentials from the environment, its flags, or the store itself (read only, no lease). Convex has a separate `generate_key` binary and a docker script reading its credentials directory | the secret may live in the database (DV-07), not in a file | pending |
| AK4 | `bunvex admin-key --read-only` issues read-only keys. Convex's format and checks support them, but only its cloud issues them | the check is already there (`is_read_only` → read-only operations); issuing one costs a flag, and a read-only key is what a viewer of the dashboard should get | pending |
| AK5 | `/stats` (a bunvex-only endpoint: engine and committer counters) requires an admin key with `ViewMetrics` | today it is open; Convex's metrics endpoints require `ViewMetrics` | pending |
| AK6 | An admin identity on a WebSocket does not expire (Convex: revalidated after 2000 s) | keys do not expire and the instance secret cannot change while the process runs, so revalidation would always succeed; not observable | pending |

Not divergences, but recorded:
- The header scheme is `Bunvex` (DV-97, decided).
- Admin writes are not audited, because bunvex has no audit log yet (platform §2, missing). They will be
  once it has one.

## 5. Tests

**Cryptography and format:**
- The RFC 8452 AES-128-GCM-SIV test vectors.
- The KBKDF output for the purpose `"admin key"`.
- Fixtures produced with `aws-lc-rs` 1.18.1 (the keybroker's library), with Convex's purpose `"admin key"`
  and `AAD = [1]`, are opened by bunvex:
  - the derived key;
  - member and system keys sealed with fixed nonces.
- Keys bunvex seals are byte-identical to those fixtures, given the same nonce. A first run of the
  prototype matched exactly.
- Prefixes (`prod:`, `dev:`, `preview:…`) are stripped.
- Each of these keys is refused with `BadAdminKey`:
  - another instance's key;
  - a tampered byte;
  - a bad version;
  - garbage.
- A read-only key carries the read-only operations.

**HTTP and sync:**
- Each identity reaches exactly what Convex lets it reach:
  - internal functions;
  - `_system/*`, as admin and as non-admin;
  - read-only versus full keys;
  - acting as a user, and `getUserIdentity()` inside the function.
- Status codes and messages for every error row.
- `check_admin_key`'s body.
- The cancel endpoints.
- The cache does not share an admin's result with a user, nor a user's with an acting user.

**CLI:** `bunvex admin-key` against a running server's store, and the key it prints works.

## 6. Open questions

- **The dashboard's HTTP data source** (`createHttpDataSource({ url, adminKey })`, UI-01 §5.7) is the UI
  session's. The endpoints above are what it needs first.
- **Deploy-scoped, time-limited keys** for impersonation in built-in auth (STUDY-28) come with that phase.

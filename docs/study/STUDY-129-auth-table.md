# STUDY-129 — `_auth`, the stored auth providers

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-27](STUDY-27-auth.md) (auth), [STUDY-35](STUDY-35-push-and-deploy.md) (push),
  [STUDY-37](STUDY-37-cli-and-environment-variables.md) (variables), [STUDY-48](STUDY-48-audit-log.md) (the push's
  `authDiff`), [STUDY-49](STUDY-49-canonical-urls.md)

## 1. How Convex does it

`crates/model/src/auth/` defines `_auth` (`AUTH_TABLE`), global, no index but the defaults; number
`DefaultTableNumber::Auth = 7`, so 519. It is loaded in memory (`APP_TABLES_TO_LOAD_IN_MEMORY`).

**Shape.** One document per provider, `AuthInfoPersisted` (`types.rs`):

- OIDC: `{applicationID, domain}` (`domain` is the `IssuerUrl`'s string);
- custom JWT: `{type: "customJwt", applicationID: string | null, issuer, jwks, algorithm}`, where `algorithm`
  is the JSON string of the enum, so it is stored with its quotes: `"\"RS256\""` (`common/src/auth.rs:100`;
  system-udfs' schema notes it: "serialized *wrapped with double quotes* (!)").

Reading accepts a missing `type` as OIDC.

**Written when.** `AuthInfoModel::put(providers)` (`mod.rs`) diffs the stored documents against the new set
(by value): it deletes the ones no longer there and inserts the new ones, leaving unchanged ones as they are,
and returns `AuthDiff {added, removed}`: each provider's document as JSON (`json_serialize`, keys in order).
Only an admin or the system may call it. It runs:

- in a push's finish transaction (`deploy_config.rs:900`, `start_push.app_auth`: the providers the evaluated
  `auth.config.js` gave, none when there is no such file). The diff is the push's `authDiff` (its answer and its
  audit event);
- when environment variables change or a canonical URL is set or unset (`application/src/lib.rs:1873, 2014,
  2025`): `reevaluate_existing_auth_config` evaluates the deployed `auth.config.js` again, in the update's
  transaction, and puts its providers ("This change would make the auth config invalid" when it fails). Only
  when an `auth.config.js` is deployed.

**Read by.**

- Every request with a user token: `Application::authenticate` reads `_auth` (`lib.rs:3218`) and validates the
  token against those providers. So the providers in force are always the stored ones; a restart evaluates
  nothing.
- The dashboard's `_system/frontend/listAuthProviders` (ViewData): `db.query("_auth").order("asc").collect()`,
  the documents as stored.
- `ConfigModel::get_*` returns them as `authInfo` only when no `auth.config.js` is deployed (legacy pushes that
  sent `authInfo` directly).

## 2. What an app can observe

- The providers tokens are checked against are the last ones stored: a push, a variable change or a canonical
  URL change.
- `finish_push`'s `authDiff` lists the providers added and removed, as JSON strings.
- The dashboard lists the providers (`listAuthProviders`).

## 3. How bunvex does it

Before: no `_auth`. The server evaluated `auth.config.js` from the code package at each start and kept the
providers in memory; the push's audit event diffed the in-memory providers; `finish_push` answered an empty
`authDiff`.

Now (`@bunvex/server` `auth-info.ts`, `push.ts`, `server.ts`; the table in `@bunvex/core` `catalog.ts`):

- `_auth`, number 519, Convex's documents (the quoted `algorithm` included).
- `putAuthInfo(db, providers)` is Convex's `put`: delete the gone, insert the new, the diff as Convex's JSON.
  It runs in the push's finish commit (no `auth.config.js`: none), and in the variables' and canonical URLs'
  update transactions when an `auth.config.js` is deployed.
- The push's audit event and its `finish_push` answer carry that diff.
- At start a deployable server builds its token verifier from `_auth`, not by evaluating the code; each commit
  above replaces it with the providers it stored.
- `_system/frontend/listAuthProviders`, as Convex's.

An embedded server (`createServer` with `auth` in its options, no pushes) keeps its providers from its options,
as before; it has no `_auth` rows.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| A1 (DV-406) | Was: no `_auth`; providers evaluated from the code at each start, kept in memory. Now as Convex: `_auth` (519), written by push, variable and canonical URL changes, read at start and by `listAuthProviders`; `finish_push`'s `authDiff` filled | match Convex's internal system tables; no legacy data | owner, 2026-10-05: match Convex |
| A2 | Tokens are checked against an in-memory copy of `_auth`, replaced when a commit writes it, not a read per request | the same providers (only this server writes `_auth`); a read per request would cost a transaction | not observable; noted |

## 5. Tests

`packages/server/test/push.test.ts` (`_auth`, the stored auth providers):

- a push stores OIDC and custom JWT providers as Convex's documents (the quoted algorithm, a null
  `applicationID`);
- `finish_push`'s `authDiff` and the audit event's `auth_diff` carry Convex's JSON;
- `listAuthProviders` returns the documents;
- the same push again keeps the documents and has an empty diff;
- a changed provider replaces only its document;
- a push without `auth.config.js` deletes them;
- a variable change re-evaluates and stores the new providers;
- a start checks tokens against `_auth`: with the documents deleted, the same token is refused.

`catalog.test.ts` checks the number.

Sabotage (each applied alone, then restored):

| Change | Result |
|---|---|
| `algorithm` stored without Convex's quotes | 1 test fails |
| `put` replaces unchanged providers too | 1 fails |
| a start evaluates `auth.config` instead of reading `_auth` | 1 fails |
| a variable change does not store the providers | 1 fails |
| `_auth` numbered 9997 | 1 fails (catalog numbers) |

## 6. Open questions

None.

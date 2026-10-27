# STUDY-186 — Convex after 72ce13c, up to precompiled-2026-10-24-bb31399
<!-- index: Convex from `72ce13c` to `precompiled-2026-10-24-bb31399`, triaged | decided (owner, 2026-10-25) -->

- **Status:** decided; triage only. The build status of A1–A19 moved to [STUDY-193 §3](STUDY-193-convex-upstream-04d2f3b.md#3-study-186-a1a19-what-is-built). The owner took every §5 recommendation on 2026-10-25 (DV-551, DV-552). Nothing is built here; each item in §4 ships on its own PR
  (or its own study), with a test and a sabotage check.
- **Convex source read:** get-convex/convex-backend from `72ce13c` (the reference since
  [STUDY-173](STUDY-173-convex-reference-2026-10-10.md)) to the release tag `precompiled-2026-10-24-bb31399`
  (2026-10-24). That is 195 commits: the 82 the daily digest (#549) listed up to `95d8719`, and 113 more. Each of the
  142 that `scripts/upstream-triage.ts` sorts as urgent or weekly was read with `git show` and checked against
  bunvex; the 53 it ignores are listed in §3.2. The `convex` npm package moved to 1.47.0 (`7058f95`) and 1.48.0
  (`1447815`) in this range.
- **bunvex code read:** `main` at `e5e00809` (after #816).
- **Process:** the weekly bump of [STUDY-138](STUDY-138-following-convex.md) and
  [upstream.md](../parity/upstream.md), steps 2–4. The reference and the differential oracle do not move in this
  study: they move with the PR that aligns §4.1, so the oracle's binary and bunvex agree on the same release.
- **Related:** DV-437 (storage in mutations), DV-476 (local dashboard `Host` check), DV-55 and
  [STUDY-62 §7.6](STUDY-62-components.md#76-convex-commits-to-take-with-components) (components),
  [STUDY-106](STUDY-106-staged-validator.md) (staged validators), [STUDY-154](STUDY-154-component-runtime.md)
  (component functions), [STUDY-174](STUDY-174-silent-bugs.md) S1 (backfill resume).

## 1. How Convex changed

Grouped by what an app or its developer sees:

- **Two new mutation features, both in convex 1.48.0.**
  - *File storage in mutations* (`886b8a4`, `e7519cb`, `cecf1de`, `14bc4e5`, public in `bde86f8`).
    `ctx.storage.store()` in a mutation stages the bytes and uploads them at commit, rerunning the mutation if the
    upload fails. `ctx.storage.get()` reads stored files, pending ones included. The limits are 10 files and
    16 MiB, read and written. This is the trigger DV-437 waits for ("keep until the upload lands upstream, then
    match").
  - *`ctx.auth.signJwt()`* (`76fe874`, `aafa4d8`, `fc49e41` reverted by `7d37097`, `2c4c29f`, `f34ac10`, `72e88b8`,
    `74a65e0`, client `3d06153` reverted by `1de00b1` and reapplied as `ebbb92c`). It signs ES256 tokens with a key
    derived from the deployment secret. `iss` is the deployment origin (plus `/components/<path>`), the lifetime is
    1 s to 1 h, and the public keys are served at `/.well-known/jwks.json`. It is mutations only.
- **Staged validators finished in the client** (`c3d9d79`, `4f81b22`). `.staged()` takes field deltas and is public.
  The CLI prints the staged validation status, asks before discarding staged validation, and adds
  `--allow-unstaging-schema`.
- **Limits.**
  - Log lines go to 1024 for V8 and Node actions and stay at 256 for queries and mutations (`04e9983`, `0e4f90d`).
  - Snapshot imports get a 64 MiB upload part (`1056bba`) and a 16 MiB JSONL line or CSV record (`a5de16c`,
    `679042f`).
  - The 90 MB zipped package limit is removed (`5695d6d`).
  - PBKDF2 is capped at 150 000 000 work units (`8856603`).
  - The data sync page is 20 000 (`315ea3e`).
  - Node 20 is refused at push (`1d7e847`).
- **Web APIs.**
  - A `Response` with status 204/205/304 cannot have a body (`a74b7c3`).
  - Action `fetch` drops the app's `Proxy-Authorization` (`9a96843`), sends `Content-Length: 0` on bodyless
    POST/PUT (`ca359c7`, `99ac14a`), and treats an infinite `setTimeout` delay as zero (`85f9693`).
- **Data sync API** (`/api/v1/data/sync`). It no longer streams hidden tables (`cb8be0f`) and falls back to by-ts
  iteration when the by-id cursor is out of retention (`fd5c7380`).
- **Engine.**
  - Index backfills resume at the latest snapshot (`6830b7a`).
  - Mutations take their concurrency permit before beginning the transaction (`d328f85`).
  - The audit log gains integration configs (`3a958a4`) and `download_export` (`8281a65`, `9d26926`).
  - The S3 export status moves to `_s3_export_state`, `DATABASE_VERSION` 134 (`ea8497f`).
  - Log stream function events carry `runtime` (`868554b`).
- **CLI.**
  - `env list --include-values` (`5a633b4`), and names only when an AI agent runs it (`7550fdd`).
  - MCP `envList` returns names by default (`eed135d`).
  - The local dashboard answers only loopback `Host`s (`6b0fa75`).
  - The local backend version is validated (`6a287a3`).
- **Groundwork, not yet in the client:** `v.function()` validators in Rust (`9003bcd`, `16dfb00`), and the
  `FunctionHandle_future` type (`d938c5b`).
- **Not for bunvex.**
  - The managed S3 export to Iceberg (Porter; see STUDY-185), usage and billing, Lambda splay, searchlight.
  - The node-executor Brotli CVE and eMudhra certificate mitigations: Lambda only, and bunvex runs `"use node"` in
    Bun (DV-87, DV-169).
  - The dashboard component switcher, the GitHub org rename, and the bundle analyzer.

## 2. What an app can observe

Once §4.1 is aligned, an app on bunvex sees what it sees on `precompiled-2026-10-24-bb31399`, except for the two
mutation features (§4.2), which wait for their studies. Until then, the differences an app can hit today are these:
- action log lines past 256;
- `new Response(body, {status: 204})`;
- `.staged({ field })`;
- PBKDF2 above the cap;
- a Node 20 push;
- the data sync API's hidden tables and page size;
- the import limits;
- the zipped package limit;
- the audit log events.

## 3. Every commit

Class: **runtime** (an app or its developer can observe it, CLI and client package included), **dashboard**,
**self-hosted ops** (nothing an app or bunvex's store observes), **cloud-only**, **docs-only**, **components**
(DV-55). Action: **none**, **align** (§4.1), **feature** (§4.2), **owner** (§5), **components list**.

### 3.1 Urgent and weekly (142)

| Commit | Subject | Class | bunvex | Action |
|---|---|---|---|---|
| `6c377f3` | internal bundle-analyzer entrypoint | cloud-only | — | none |
| `886b8a4` | [4/n] upload the files a mutation stored | runtime | `store()` throws in mutations (`server/src/storage.ts:284-288`, DV-437) | feature |
| `e7519cb` | [5/n] `storageGet` syscall stub | runtime | the mutation writer has no `get` (`storage.ts:279-289`) | feature |
| `cecf1de` | [6/n] get stored files in mutations | runtime | not built | feature |
| `7a6b304` | bundle-analyzer build kind rename | cloud-only | — | none |
| `845f40a` | `deployment create` hint after `project create` | cloud-only (CLI) | no `project create` | none |
| `eed135d` | MCP `envList` names only by default | runtime (CLI) | returns values (`cli/src/mcp-tools.ts:346-354`) | align |
| `5a633b4` | `env list --include-values` | runtime (CLI) | refused as unknown (`cli/src/env.ts:235`) | align |
| `d5fc921` | MySQL v6 index pages and bucket bounds | self-hosted ops | no v6 layout | none |
| `cb8be0f` | `include_hidden: false` in data sync | runtime (data sync API) | hidden tables streamed (`server/src/data-sync.ts:292-305`, `streaming-export.ts:221-226`) | align |
| `f11b435` | MySQL components for index shadowing | self-hosted ops | — | none |
| `b8fb288` | one scan for backfill cursors | runtime-internal | already fine: per-index reads in a system tx, not counted (`core/src/index-worker.ts:205-226`, `tx.ts:1052-1054`) | none |
| `5417153` | deduplicate pending index backfills | runtime-internal | no progress-keyed queue (`index-worker.ts:149-172`) | none |
| `6dcf063` | remove `StreamingExportFilter` | runtime (refactor) | legacy endpoints keep hidden tables, as bunvex does | none |
| `6830b7a` | resume backfills at the latest snapshot | runtime (backfill after restart) | resumes at the checkpoint's snapshot; past retention restarts from zero (`index-worker.ts:272-289`) | align (§4.1, study note first) |
| `6de3b45` | backend info / audit firehose config move | cloud-only | — | none |
| `900eba4` | JWKS metrics | self-hosted ops | — | none |
| `220f6aa` | unchanged-key index write metric | self-hosted ops | — | none |
| `1a9f5e1` | retry deadlocked commit batches (urgent) | runtime | fixed in #746 (STUDY-173 §5) | none |
| `6a6c5dd` | client ID on health checks | self-hosted ops | — | none |
| `3a958a4` | integration config in audit events | runtime (audit log) | events carry `{id, type}` only (`server/src/audit-log.ts:86-88`) | align |
| `6b53075` | default UDF runtime to Funrun | cloud-only | — | none |
| `20ef1e2` | BTreeMaps in `IndexIntervals` | self-hosted ops | — | none |
| `c3d9d79` | field deltas in `.staged()` | runtime (schema) | object taken as the whole validator (`core/src/schema.ts:328-333`) | align |
| `1d7c216` | ids past the editor's lookup cap | dashboard | — | none |
| `1943768` | tree-based component switcher | dashboard (components) | DV-55, DV-224 | components list (with `b7463e1`, `e324c6f`, `7fce6d2`) |
| `c93d1c0` | staged validators in health page progress | dashboard | `schemaValidationProgressByTable` not built; same gap as STUDY-173 Q2 | none |
| `87fbe00` | V5 shadowing boundary | self-hosted ops | — | none |
| `d62e1c7` | comments around data sync (urgent) | comments | no change (#712) | none |
| `4f81b22` | CLI staged-schema output, `--allow-unstaging-schema` | runtime (CLI) | server side ready (DV-438 PR 6, `server/src/push.ts:584-599`); CLI has none (`cli/src/deploy.ts:685-700`) | feature |
| `902e092` | S3 export progress across selection changes | runtime (log stream API) | field filters accepted (`server/src/log-sinks-routes.ts:240-259`, `:345-350`) | align |
| `14bc4e5` | no pending uploads at commit | runtime-internal | comes with storage in mutations | feature |
| `5695d6d` | remove the zipped package limit | runtime (push) | still 90 000 000 (`server/src/code-store.ts:37-49`, `:135`) | align |
| `fd5c738` | data sync by-ts fallback past retention | runtime (data sync API) | expired-cursor error (`data-sync.ts:356-361`) | align |
| `f8b62ad` | freeze an S3 export's destination | runtime (log stream API) | destination can change (`log-sinks-routes.ts:345-350`); existence check outside the insert tx (`:480-489`) | align |
| `3782e2f` | reserve searchlight field | cloud-only | — | none |
| `d7402d6` | reactive pagination in component queries | runtime (component functions, STUDY-154) | "paginate() is only supported in the app." (`core/src/tx.ts:1609`) | align |
| `76fe874` | deployment JWT signing syscall | runtime | not built | feature |
| `04e9983` | split and raise log line limits | runtime (limit) | one `MAX_LOG_LINES = 256` (`server/src/logs.ts:21`, `sandbox/src/child-call.ts:543`) | align |
| `b7463e1` | sort components in switcher | dashboard (components) | — | none |
| `aafa4d8` | `/.well-known/jwks.json` | runtime (HTTP route) | not built | feature |
| `7058f95` | npm 1.47.0 | client release | items triaged one by one; bunvex announces its own version (STUDY-139) | none |
| `403c3e8` | races acquiring the lease (urgent) | runtime (store) | fixed in #748 (DV-505) | none |
| `0c16e03` | reserve `TokenMatch.distance` | cloud-only | — | none |
| `c8efaf7` | double lambda splay | cloud-only | — | none |
| `0e4f90d` | action log limit to the Node executor | runtime (limit) | `"use node"` capped at 256 | align (with `04e9983`) |
| `3dea040` | atomicity copy in data sync docs | docs-only | — | none |
| `f6119f0` | Vercel billing copy | dashboard (cloud) | — | none |
| `9203a3e` | classify MySQL IO errors | self-hosted ops (retry policy) | broader retry set (`persistence/src/mysql.ts:210-219`) | owner (Q5) |
| `2c1dfca` | redact env values in `--verbose` push | runtime (CLI) | no `--verbose`; the push response is never printed | none |
| `84d970d` | GitHub org rename (build, images) | self-hosted ops | no ai-files or backend download path touched | none |
| `234a8bd` | GitHub org rename (docs, links) | docs-only | `github.com/get-convex/…` links redirect | none |
| `8449d41` | repeated pagination in mutations (urgent) | runtime | fixed in #747 | none |
| `fc49e41` | reserve `jti` | runtime | not built (reverted by `7d37097`) | feature |
| `2c4c29f` | deployment JWT max lifetime 1 h | runtime | not built | feature |
| `1daf6f3` | `ai-files` exit 1 on failed downloads | runtime (CLI) | no `ai-files` command | none |
| `95d8719` | usage: drop storage identity fields | cloud-only | — | none |
| `3d06153` | `ctx.auth.signJwt` in mutations | runtime (client) | not built (reverted, reapplied as `ebbb92c`) | feature |
| `7c157dd` | remove get-convex reference | docs-only | — | none |
| `1056bba` | bound the import part body | runtime (limit) | reads any size (`server/src/server.ts:2231-2237`; exempt from the body cap, `:1727-1734`) | align |
| `a5de16c` | import JSONL line limit | runtime (limit) | no bound (`server/src/import-parse.ts:64-101`, zip `:331-357`) | align |
| `f8f91f2` | refactor `ActionEnvironment` | runtime-internal | — | none |
| `9003bcd` | function validators in Rust | runtime groundwork | not built; no `v.function()` in the client yet | none (feature when the client ships it) |
| `3c0ef26` | Sentry through smokescreen | self-hosted ops | — | none |
| `ea8497f` | `_s3_export_state`, `DATABASE_VERSION` 134 | store layout | at 133 (`core/src/database-globals.ts:14`), no table in `catalog.ts:132-170` | align (with the reference move) |
| `1cf6130` | remove `dims` usage field | cloud-only | — | none |
| `85f9693` | infinite `setTimeout` delay as zero | runtime (Web API) | already matches: Bun fires `Infinity` and `NaN` at ~1 ms (probed) | none |
| `679042f` | CSV record limit | runtime (limit) | no bound (`import-parse.ts:124-175`) | align (with `a5de16c`) |
| `1de00b1` | revert signJwt (urgent) | runtime | superseded by `ebbb92c` | none |
| `7a5c98d` | S3 export worker spans | self-hosted ops | — | none |
| `20f4fba` | plan pricing API | dashboard (cloud) | — | none |
| `891bf28` | `SerializedCompletedSpan` serde | runtime-internal | bunvex sends `spans: []` (`cli/src/deploy.ts:773`) | none |
| `8856603` | limit PBKDF2 iterations | runtime (Web API) | Bun's `crypto.subtle` has no cap (`core/src/determinism.ts:433-450`; 2.4M iterations derived in 185 ms) | align |
| `307a4dc` | nesting limit in `StructuralShape` | self-hosted ops | no app input reaches it | none |
| `9a96843` | proxied fetches send only the configured client id | runtime (action `fetch`) | the app's `Proxy-Authorization` reaches the target, or doubles with the instance's (`server/src/http-proxy.ts:67`; probed) | align |
| `ef4b77f` | S3 upload part numbering | self-hosted ops | `partNumber` read, unused | none |
| `85533b0` | client clock skew cleanup | runtime (sync) | already matches for negative `clientTs` (`sync.ts:1305`) | none |
| `45ec26a` | source-mapped error context | runtime (push errors) | context block printed even when the column is past the line (`server/src/definition-eval.ts:256-258`) | align |
| `9d26926` | read `download_export` audit events | runtime (audit log) | no such event (`audit-log.ts:39-46`) | align (with `8281a65`) |
| `ea09690` | more action refactoring | runtime-internal (wasm) | — | none |
| `19a02df` | S3 exports under `data-lake/` | cloud-only (Porter) | drain stub (`log-sinks.ts:300`) | none |
| `9ff64aa` | S3 export cursor out of the backend | cloud-only | — | none |
| `d938c5b` | `FunctionHandle_future` type | runtime (client types, 1.48.0) | not exported (`server/src/index.ts`) | align |
| `41c6b42` | splay knob | cloud-only | — | none |
| `1e7ca57` | sync worker histograms | self-hosted ops | — | none |
| `f9171b4` | usage: aggregate storage calls | cloud-only | — | none |
| `7d37097` | revert `jti` reservation (urgent) | runtime | not built | feature |
| `f34ac10` | `sub` must be a string | runtime | not built | feature |
| `e324c6f` | expand-all in component switcher | dashboard (components) | — | none |
| `7c63217` | db verifier on v6 | self-hosted ops | — | none |
| `72e88b8` | `nbf` is reserved | runtime | not built | feature |
| `5868ab0` | read-only transactions skip the committer | self-hosted ops | same begin timestamp | none |
| `84e02e7` | commit-persisted metric | self-hosted ops | — | none |
| `06581ba` | JSON number encode allocation | self-hosted ops | same output | none |
| `6026030` | billable metrics | cloud-only | — | none |
| `77ebe5c` | `storage_from_proto` move | cloud-only | — | none |
| `cbb5dc0` | rust-analyzer features | self-hosted ops | — | none |
| `cacb9c9` | schema worker round trips | self-hosted ops | — | none |
| `53c02d0` | backfill progress vs MySQL transactions | self-hosted ops | — | none |
| `7fce6d2` | component select gutter | dashboard (components) | — | none |
| `2c88d7e` | team-scoped SSO | cloud-only | — | none |
| `7550fdd` | `env list` names only for AI agents | runtime (CLI) | always prints values unless `--names-only` | owner (Q2) |
| `6c0a487` | schema worker tables in parallel | self-hosted ops | default 1, no behaviour change | none |
| `ca359c7` | `Content-Length: 0` on bodyless POST/PUT | runtime (action `fetch`) | already matches (Bun 1.4.4, probed) | none |
| `99ac14a` | override user `Content-Length` there | runtime (action `fetch`) | already matches (probed) | none |
| `35e8bb6` | S3 export alerts | cloud-only | — | none |
| `3a32a4a` | `nodeVersion` in the config JSON schema | docs-only | no JSON schema shipped | none |
| `b180cae` | price API discount | cloud-only | — | none |
| `3739248` | unused cargo dependencies | self-hosted ops | — | none |
| `ebbb92c` | reapply `ctx.auth.signJwt` | runtime (client) | not built | feature |
| `a74b7c3` | null-body statuses | runtime (Web API) | `new Response("x", {status: 204})` accepted (`server/src/web-response.ts:63-90`); the `fetch` side already matches | align |
| `41c0bf9` | evict index cache on metadata change | runtime-internal | already fine: cache checked lazily against the write log (DV-432, `core/src/index-cache.ts:96-120`) | none |
| `c56fb4e` | bill S3 export pages | cloud-only | — | none |
| `bde86f8` | storage in mutations public | runtime (client, 1.48.0) | metrics still `@internal` (`server/src/meta.ts:17-24`) | feature |
| `315ea3e` | data sync page 16384 → 20000 | runtime (data sync API) | 16384 (`data-sync.ts:43`) | align |
| `944a6b4` | indexing build fix (urgent) | self-hosted ops (tests) | — | none |
| `16dfb00` | keep `v.function()` signatures | runtime groundwork | no `function` in `values/src/validators.ts` | none (with `9003bcd`) |
| `d328f85` | mutation permit before the transaction | runtime (fewer OCC retries) | permit taken inside the transaction (`server/src/functions.ts:1866-1889`) | align (with a measurement) |
| `3ccbd6a` | Vercel team rename | cloud-only | — | none |
| `8281a65` | `download_export` audit event | runtime (audit log) | `download()` records nothing (`server/src/exports.ts:469`) | align |
| `1d7e847` | refuse Node 20 | runtime (push) | accepts "20" (`server/src/push.ts:256`) | align |
| `6b0fa75` | local dashboard only on loopback `Host` | runtime (CLI) | DV-476 checks only `/api/current_deployment` (`cli/src/dashboard-server.ts:166-169`) | owner (Q3) |
| `6a287a3` | validate the local backend version | runtime (CLI) | used unchecked in a cache path and URL (`cli/src/local-deployment.ts:176-184`) | align |
| `74a65e0` | missing JWT key is an internal error | runtime | not built | feature |
| `b16c3fc` | MySQL v6 range deletes | self-hosted ops | — | none |
| `b948910` | unused `db_should_be_leader` | self-hosted ops | — | none |
| `1447815` | npm 1.48.0 | client release | items triaged one by one | none |
| `93b6fa8` | remove unused dashboard code | dashboard | — | none |
| `5f8b0be` | AI gateway JWT 5 min | cloud-only | `AiGatewayUnavailable` (DV-491) | none |
| `932e84b` | spend column | dashboard (cloud) | — | none |
| `342530f` | spend column dates | dashboard (cloud) | — | none |
| `aaf9955` | monorepo Node 24 | tooling | — | none |
| `868554b` | `function.runtime` in log stream events | runtime (log streams) | no `runtime` (`server/src/log-events.ts:158-167`) | owner (Q4) |
| `7b59d2b` | npm dependency bumps | tooling | — | none |
| `e631122` | S3 export checkpoint transaction | cloud-only | — | none |
| `703314a` | node-executor Brotli (CVE) | cloud-only (Lambda) | `"use node"` runs in Bun (DV-87, DV-169) | none (Q6) |
| `81e0448` | eMudhra distrust in Node actions | cloud-only (Lambda, flagged) | Bun's root store | none (Q6) |
| `7b7b58e` | cache AWS credentials | self-hosted ops | knob never read | none |
| `8424ecd` | card hold note | dashboard (cloud) | — | none |
| `529e62b` | revert the eMudhra series | cloud-only | — | none |
| `61037f2` | Brotli mitigation on Node 22 | cloud-only | — | none |
| `bb31399` | reapply the eMudhra distrust | cloud-only | — | none |

### 3.2 Ignored by the script (53)

Docs, demos, tooling and the bundle analyzer. None reaches an app.
- **Bundle analyzer:** `27f5905`, `0993628`, `a33986b`, `d0ce422`, `95b8fbf`, `d68551a`, `eb12cf1`, `bc8c7ca`,
  `f9c5f33`, `942bbcb`, `8105f3b`, `9b82bc0`, `0a28b11`, `6212565`, `df78c92`.
- **Docs:** `13731cb`, `aa8a893`, `532492a`, `81affb4`, `c24a3de`, `e9f437e`, `9931056`, `31f30d3`, `5372831`,
  `ec67e20`, `0f38843`, `fdec991`. The AI Gateway model lists: `863869c`, `e4d6440`, `b5998b3`, `8abff58`,
  `29d255a`, `63a1d8e`, `6c7e768`, `0fdfdbb`, `65a9491`.
- **Changelogs:** `b89cde5`, `f068c0e`.
- **Agent docs and lint plugin:** `b81f8c3`, `ba742e5`, `a80385e`.
- **convex-helpers bumps:** `e3a3a28` (0.1.128), `12395fc` (0.1.129). `@bunvex/helpers` tracks `e48f9df` on its own
  ([upstream.md](../parity/upstream.md#other-repositories)).
- **Managed S3 export (Porter):** `5c8a555`, `3df57ae`, `db19afd`.
- **Demos, build and lock files, dashboard flags:** `83cf0e0`, `d6b3b75`, `5bffef4`, `6dca079`, `25df6d5`,
  `7034644`, `b229e5f`.

## 4. What bunvex changes

### 4.1 Align (one PR each, or grouped where noted)

| # | Convex | bunvex change |
|---|---|---|
| A1 | `04e9983` + `0e4f90d` | Log line limits: 1024 for actions (V8 and `"use node"`), 256 for queries and mutations. The overflow line counts inside the limit ("Log overflow (maximum N). Remaining log lines omitted.") (`server/src/logs.ts`, `sandbox/src/child-call.ts`) |
| A2 | `1056bba`, `a5de16c`, `679042f` | Import limits: 400 past 64 MiB per upload part ("Import upload parts must be at most 67108864 bytes."); 16 MiB per JSONL line and per CSV record (multi-line quoted fields count as one), in bunvex's wording of "JSONL line {n} exceeds the maximum length of {limit} bytes" (`server/src/server.ts`, `import-parse.ts`) |
| A3 | `5695d6d` | Drop the zipped package limit and its message; keep 230 000 000 unzipped (`server/src/code-store.ts`) |
| A4 | `8856603` | PBKDF2 `deriveBits`/`deriveKey`: `OperationError` "too many iterations" when `iterations × max(bytes, 64) > 150 000 000` (`core/src/determinism.ts`) |
| A5 | `a74b7c3` | `new Response(body, {status: 204/205/304})` with a body throws `TypeError` (`server/src/web-response.ts`) |
| A6 | `9a96843` | Action `fetch` drops the app's `Proxy-Authorization` (`server/src/action-fetch.ts`). This touches #833's files, so it waits for #833 to merge |
| A7 | `c3d9d79` | `.staged({ field })` merges deltas into the enforced object; `undefined` removes a field; a union or record table throws Convex's message (`core/src/schema.ts`) |
| A8 | `d7402d6` | Allow `paginate()` in component queries, one per query function across the app and its components (`core/src/tx.ts:1609`); STUDY-154 rows updated |
| A9 | `cb8be0f`, `fd5c738`, `315ea3e` | Data sync: no hidden tables; by-ts fallback when the by-id cursor is out of retention; page 20 000 (`server/src/data-sync.ts`) |
| A10 | `6830b7a` | Resume an index backfill after its cursor at a fresh snapshot, keeping the count. A short note first, on why bunvex's per-document write timestamps make that safe (STUDY-174 S1) (`core/src/index-worker.ts`) |
| A11 | `d328f85` | Take the mutation permit before the transaction begins; cron and scheduled mutations keep the old order (`server/src/functions.ts`). Measured under contention |
| A12 | `3a958a4`, `8281a65`, `9d26926` | Audit log: integration `config` / `previous` / `current` / `credentialChanges` (redacted as Convex does); `download_export` on a ZIP download (`server/src/audit-log.ts`, `exports.ts`) |
| A13 | `902e092`, `f8b62ad` | S3 export API: 400 `FieldFiltersUnsupported` on field filters; an update naming the bucket, region, prefix or access key ID is 400 `BadJsonBody` ("unknown field …", the update's arguments deny unknown fields; `S3ExportDestinationChanged` cannot fire through the API, STUDY-185 §1.3); existence check inside the insert transaction (`server/src/log-sinks-routes.ts`). Built with STUDY-185 §2.2's rows |
| A14 | `ea8497f` | `_s3_export_state` in the catalog and `DATABASE_VERSION` 134, with the reference move (a Convex 134 store must open without the "ahead" warning) |
| A15 | `1d7e847` | Refuse `nodeVersion` "20" as "18" is: "Node 20 is no longer supported. Upgrade to a newer Node version." (no link, DV-04) (`server/src/push.ts`) |
| A16 | `5a633b4`, `eed135d` | `env list --include-values` (conflicts with `--names-only`); MCP `envList` returns names unless `includeValues` (`cli/src/env.ts`, `mcp-tools.ts`). The agent default is Q2 |
| A17 | `6a287a3` | Validate `--local-backend-version` against `precompiled-YYYY-MM-DD-…` before it reaches a path or URL: "Invalid local backend version" (`cli/src/local-deployment.ts`). This also closes a path traversal |
| A18 | `45ec26a` | Source-mapped push errors: fall back to `name:line:col: msg` at the generated position when the mapped column is past the line (`server/src/definition-eval.ts`) |
| A19 | `d938c5b` | Export `FunctionHandle_future` from `bunvex/server` (type only), with an api-shapes test |

### 4.2 New features (own study each)

- **Storage in mutations** (`886b8a4`, `e7519cb`, `cecf1de`, `14bc4e5`, `bde86f8`). DV-437's condition is met. The
  study covers:
  - the upload at commit and the rerun on failure;
  - `get()` with pending uploads;
  - the four limits and their errors;
  - the public `meta` fields.
- **`ctx.auth.signJwt` and `/.well-known/jwks.json`** (`76fe874`, `aafa4d8`, `2c4c29f`, `f34ac10`, `72e88b8`,
  `74a65e0`, `ebbb92c`). The study must cover:
  - how the ES256 key derives from bunvex's instance secret, so that a store the Convex binary wrote serves the same
    JWKS;
  - the reserved `convex`/`cvx` claim prefixes (Q1).
- **CLI staged-schema output** (`4f81b22`). It extends STUDY-106; the server side is already built (DV-438).
- **`v.function()`** (`9003bcd`, `16dfb00`). Nothing until Convex's client exposes it.

### 4.3 Found on the way, not from these commits

In a V8 action, a finite `setTimeout` delay above 2^31−1 ms fires after about 1 ms. Actions use Bun's `setTimeout`
directly (`server/src/code-version.ts:326`), while Convex sleeps the full duration. `core/src/long-timer.ts`
(`MAX_TIMER_MS`) exists, but actions do not use it. This needs a test, then an align PR.

## 5. Owner questions

Decided (owner, 2026-10-25): every recommendation below, as written. Q2 is DV-551 and Q4 is DV-552. Q3 moves DV-476
to "Resolved to match Convex" in the PR that builds it. Q1 is settled inside the signJwt study, and Q5 is an align
item like §4.1's.

| # | Question | Recommendation (decided) |
|---|---|---|
| Q1 | `signJwt` refuses claims prefixed `convex` / `cvx` as reserved. Rule 5 keeps "convex" out of shipped strings, but an app moving from Convex would be surprised if bunvex accepted `convexFoo`. Reserve the same prefixes (a rule-5 exception like DV-226), reserve `bunvex`, or both? | Reserve Convex's prefixes for parity, and word the message in bunvex's words; decide inside the signJwt study |
| Q2 | `env list` prints names only when it detects an AI agent (`@vercel/detect-agent` or `CONVEX_AGENT_MODE`), with a stderr note. Take it? With which detector, and which variable name in place of `CONVEX_AGENT_MODE`? | Take it, using bunvex's own detection list (no new dependency), with `BUNVEX_AGENT_MODE`; record it as a DV for the variable name |
| Q3 | Convex's local dashboard now answers 403 with an empty body to every non-loopback `Host`. DV-476 checks only `/api/current_deployment`, and its Convex column ("answers any Host") is out of date | Extend the check to every path with Convex's empty 403. DV-476 then moves to "Resolved to match Convex" |
| Q4 | Log stream events carry `function.runtime`: `"convex"` for the isolate, `"node"`, or `null`. Rule 5 forbids `"convex"` | Send `"bunvex"` for V8 functions and `"node"` for `"use node"`, recorded as a rule-5 DV (DV-456 precedent) |
| Q5 | Convex now retries only ConnectionRefused, ConnectionReset, UnexpectedEof and a temporary DNS failure from MySQL. bunvex also retries `EPIPE`, `ETIMEDOUT`, `EHOSTUNREACH` and `ENETUNREACH`, and not `EAI_AGAIN` | Match Convex's set (add `EAI_AGAIN`, drop the four). Nothing an app observes changes, except fewer retries on a dying network |
| Q6 | The node-executor Brotli CVE and the eMudhra distrust are Lambda-only in Convex. bunvex runs `"use node"` in Bun, so neither path exists, but whether Bun's own Brotli and root store are affected was not checked | No divergence. A separate check of Bun's zlib/Brotli and its root store for eMudhra, outside parity |

Q5, a note (2026-10-27, after K21 failed on MySQL in merge-group run 40587403398). `9203a3e` was written for alert
severity (a "packet is too large" error was paged as operational), but the same `DatabaseOperationalError` decides
the retries too: `is_transient_db_error` (`crates/common/src/errors.rs`) is what the write batcher retries a flush on
(`write_batcher.rs:231`), and `handle_errors_with_retries` (`crates/mysql/src/connection.rs`) retries a read on it. So
#911 narrowed the right mechanism. What it missed is a connect that hangs. mysql_async 0.37 has no connect timeout,
and its pool does not retry a fresh connect that fails (`GetConn` only drops and replaces an idle connection that
fails its check). Convex bounds `pool.get_conn()` with the same `with_timeout` as every statement
(`acquire_internal`), so a connect that hangs fails with `DatabaseTimeoutError`, which is transient, and never with
`Io(TimedOut)`: the kernel's own connect timeout (about 2 minutes on Linux) is far past `MYSQL_TIMEOUT_SECONDS`.
mysql2 has its own connect timer (`connectTimeout`, set to the call's timeout), and its `connect ETIMEDOUT` fell under
the dropped `ETIMEDOUT`, so the committer stopped where Convex retries. bunvex now reads mysql2's own connect timeout
as the call's `DatabaseTimeoutError` (`connectTimedOut`, `persistence/src/mysql.ts`). An `ETIMEDOUT` from a query, or
from the operating system, stays non-operational, as in Convex.

## 6. Tests

None in this study: it is a triage. Each §4.1 item comes with its own test, red before and green after, and a
sabotage check. A11 also comes with a measurement. The differential run against `precompiled-2026-10-24-bb31399`
comes with the reference move (A14).

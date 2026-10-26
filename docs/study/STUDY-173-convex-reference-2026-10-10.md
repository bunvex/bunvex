# STUDY-173 — Convex from d8bdde0 to precompiled-2026-10-10-72ce13c
<!-- index: Convex from d8bdde0 to `precompiled-2026-10-10-72ce13c`: the 30 commits classified and the 11 carried ones resolved; 8917f16's `env set` instructions taken in the CLI (and `MissingEnvironmentVariables` handled, `dev` pushing again once the variables are set); the four urgent commits after the release (8449d41, 403c3e8, 1a9f5e1, d62e1c7) and their fix branches; the differential oracle moved to that release | implemented; owner decisions 2026-10-19: no new divergence (Q1 DV-494, Q3 DV-477), `indexes:backfilling` a gap until the dashboard's deploy-progress line (Q2) -->

- **Status:** implemented; the owner's questions (§6) decided on 2026-10-19: no new divergence.
- **Convex source read:** get-convex/convex-backend from `d8bdde0` (the reference since
  [STUDY-137](STUDY-137-convex-reference-2026-10-07.md)) to the release tag `precompiled-2026-10-10-72ce13c`
  (2026-10-09). That is 30 commits; 11 of them were carried by STUDY-137's bump (`upstream.md`'s "Carried to the
  next bump"). Each of the 30 was read with `git show` and checked against bunvex. The published `convex` npm package
  is still 1.46.0 at this tag.
- **bunvex code read:** `main` at `ac5aa7d5` (after #741).
- **Process:** the weekly bump of [STUDY-138](STUDY-138-following-convex.md) and
  [upstream.md](../parity/upstream.md).
- **Related:**
  - [STUDY-122](STUDY-122-differential-testing.md): the differential oracle moves to this release.
  - [STUDY-106](STUDY-106-staged-validator.md) (staged validators, DV-438), [STUDY-62 §7.6](STUDY-62-components.md#76-convex-commits-to-take-with-components)
    (commits taken with components), [STUDY-149](STUDY-149-dashboard-real-data.md) (dashboard links, DV-477),
    [STUDY-153](STUDY-153-component-push.md) (`bunvex.config.ts`, DV-494).

## 1. How Convex changed

The range holds one change an app's developer sees on bunvex's side, in the CLI, and nothing new in the runtime that
bunvex lacks:

- **8917f16 — How to set a missing environment variable** (`npm-packages/convex/src/cli/lib/config.ts`,
  `setEnvVarsInstructions`).
  - A push refused for a variable the auth config reads (`AuthConfigMissingEnvironmentVariable`) used to end with
    "Go set it in the dashboard or using `npx convex env set`", or "Go to: <dashboard page> to set it up."
  - It now prints "Set it with:" (or "Set them with:" for several names) and one indented `env set <NAME> <value>`
    command per name (`<NAME>` when none is known). The command names the deployment: `--deployment <name>` for a
    cloud one, `--prod`, or `--url <url> --admin-key <admin key>` for a push made by URL and admin key (the key
    stays a placeholder, kept out of the terminal). A local or anonymous deployment needs no flag.
  - Then "or in the dashboard:" and the Environment variables page, with `?var=<name>` only for a single name, when
    the deployment has a dashboard to link.
  - `MissingEnvironmentVariables` (a variable `convex.config.ts` requires is unset) is now handled too: the names
    are read from the server's message (`are not set: A, B.`) and printed as "Environment variable A is declared as
    required in convex.config.ts but its value was not set." or "Environment variables A, B are declared … but their
    values were not set.", then the same instructions. The push exits as "invalid filesystem or env vars", so
    `dev` waits for a file or a variable to change.
  - The same commit passes a preview deployment's name to the push: cloud-only (DV-186).
- **The staged-validator series** (900fe2c, e049178, 7236c10, 5b65aed): carried from STUDY-137 and already built
  as DV-438 (STUDY-106 §7.5, PRs 3–6).
- **e748f4c — FormData** non-string values and `set()` with repeated names: functions use Bun's FormData (DV-164),
  which already does both (probed: `append("a", 1)` gives `"1"`; after `set("a", 5)` one `a` is left, at the first
  position).

## 2. What an app can observe

- The CLI's text when a push lacks an environment variable, and `bunvex dev` pushing again once a variable that
  `bunvex.config.ts` requires is set.
- Nothing else: the other commits are cloud-only, self-hosted operations, the dashboard behind flags Convex's
  self-hosted dashboard turns off, docs, or already built.

## 3. Every commit

Class: **runtime** (an app or its developer can observe it), **dashboard**, **self-hosted ops** (nothing an app or
bunvex's store observes), **cloud-only**, **docs-only**. The first 11 rows are the commits STUDY-137 carried.

| Commit | Subject | Class | bunvex | Action |
|---|---|---|---|---|
| `f9b2d83` (carried) | component-scoped custom-role statements | components (DV-55), cloud RBAC | bunvex has no custom roles | none; stays on [STUDY-62 §7.6](STUDY-62-components.md#76-convex-commits-to-take-with-components) |
| `900fe2c` (carried) | check writes against staged validators | runtime | DV-438 PR 3 | already matches |
| `e748f4c` (carried) | FormData non-string values, `set()` with repeated names | runtime (Web API) | Bun's FormData (DV-164) behaves so | already matches |
| `a4ad353` (carried) | docs: function bundle size limits | docs-only | limits taken in #539 | none |
| `e049178` (carried) | background walk of staged validators | runtime | DV-438 PR 4 | already matches |
| `7236c10` (carried) | reuse validated staged schemas; a table's deletion invalidates them | runtime; the CLI's `supersetOfStagedValidated` | DV-438 PR 5; the CLI types `outcome` as a string (`cli/src/index-checks.ts`) | already matches |
| `02fe59b` (carried) | docs: AI Gateway model list | docs-only (cloud) | — | none |
| `56a59a9` (carried) | docs: AI gateway voice | docs-only (cloud) | — | none |
| `5b65aed` (carried) | `evaluate_schema`: staged state, promotion skip, discard prediction | runtime | DV-438 PR 6; Convex's CLI does not consume it yet at this tag | already matches |
| `c178e47` (carried) | published MySQL v6 buckets before index displacement | self-hosted ops | Convex's MySQL v6 writer only | none |
| `076c52c` (carried) | dashboard: schema validation and backfill progress on the health page | dashboard | Convex's self-hosted dashboard sets `healthDeployProgressEnabled: false` (`dashboard-self-hosted/src/pages/_app.tsx`). Its id-encoding hunk (table number 0 refused) is already bunvex's (`values/src/id.ts`) | gap recorded (§6 Q2) |
| `2f1ab08` | S3 export: table selection in settings | dashboard | Convex's self-hosted dashboard hides S3 export (`s3ExportIntegrationEnabled: false`); bunvex's API takes `selection` already | already matches |
| `bb95347` | logs page: search query in the URL | dashboard | bunvex keeps the log view in the URL (`useLogViewInUrl`, STUDY-12 L7) under its own parameter names | already matches |
| `8917f16` | instructions to set environment variables | runtime (CLI) | §4 | **taken** |
| `72ce13c` | usage: aggregate database bandwidth | cloud-only | — | none |
| `bab3490` | missing Glue table treated as missing | cloud-only (Iceberg) | — | none |
| `59b8ddf` | pace deployment-deletion batches | cloud-only | — | none |
| `04e5f23` | audit-log bandwidth by minute | cloud-only | — | none |
| `bc51756` | load-generator client ID | self-hosted ops (internal tool) | — | none |
| `b0694b4` | MySQL v6 refactor, no logic change | self-hosted ops | — | none |
| `5402619` | S3 export worker metrics | self-hosted ops | — | none |
| `e613935` | shared firehose transports | cloud-only | — | none |
| `7ba087f` | remove the big-brain Sentry endpoint | cloud-only | — | none |
| `fa29519` | docs: AI Gateway model list | docs-only (cloud) | — | none |
| `deb555a` | ai-sdk-provider 0.3.0 | cloud-only (AI gateway) | — | none |
| `fb40691` | ai-sdk-provider: ZDR routing | cloud-only | — | none |
| `124da78` | docs: ZDR availability | docs-only (cloud) | — | none |
| `b08985e` | ai-sdk-provider: retry transcription | cloud-only | — | none |
| `9a1516f` | lazy Iceberg table load | cloud-only | — | none |
| `2b74c8c` | AI Gateway privacy and price preferences | cloud-only | — | none |

**The 11 carried commits are resolved:** the four staged-validator commits are built (DV-438), FormData already
matches, `c178e47` and the three docs commits need nothing, `076c52c` is a recorded gap (§6 Q2), and `f9b2d83`
stays on STUDY-62 §7.6. `upstream.md`'s carried table is empty after this bump.

No commit in the range is urgent for bunvex: its one runtime fix (FormData) is Bun's behaviour already. DV-437
(`ctx.storage.store()` in mutations) stays as decided: no upload commit is in the range.

## 4. What bunvex changes

| Convex | bunvex | Test |
|---|---|---|
| 8917f16 | `setEnvVarsInstructions` and `missingEnvVarsMessage` in `cli/src/deploy.ts`: "Set it/them with:", one `bunvex env set NAME <value>` per name (`<NAME>` with none), `--url <url> --admin-key <admin key>` unless the deployment is the project's local one (`DeployOptions.local`, from `acquireTarget` and `dev`); then "or in the dashboard:" and the Environment variables page (`?var=` for one name) only while a dashboard is served (DV-477). `MissingEnvironmentVariables` names the variables with `bunvex.config.ts` (DV-494) and returns `envVars: true`, so `bunvex dev` pushes again once the deployment's variables change | `cli/test/dashboard-links.test.ts` (local deployment with a dashboard; two required variables; a URL target by variables and by flags), `cli/test/dev.test.ts` (the auth config's variable by URL; two required variables, then a push once both are set) |

bunvex has no `--deployment` or `--prod` (DV-186), so the two cloud flags have no counterpart. Convex's `bold`
styling is not reproduced: bunvex's push errors are plain text.

**Test first, then the sabotage check.** The three tests were written first and failed against `main` (old wording;
`MissingEnvironmentVariables` printed raw as "Hit an error while pushing: …"). With the change they pass. Then:
- with `envVars: true` dropped from the `MissingEnvironmentVariables` branch, the `dev` test times out waiting for
  the push after the variables are set;
- with the URL flag never printed, all three fail;
- with the whole `src` change removed, all three fail.

Measurement: none needed. The change runs only on a refused push.

## 5. After the reference: the urgent commits

82 commits on Convex's `main` follow `72ce13c` (at `95d8719`, 2026-10-16). They are not triaged here: the daily
digest issue (#549) tracks them, and the next bump takes them from the next release. Four were urgent (a fix in the
engine or the runtime) and were studied at once, as the process says:

| Commit | Subject | bunvex | Verdict |
|---|---|---|---|
| `8449d41` (#718) | allow repeated pagination in mutations | bunvex refuses a mutation's second `paginate()` (`core/src/tx.ts`, one flag per transaction shared with nested calls). Convex now limits only queries, gives a mutation's nested query its own journal, and words the message for a query function | **affected**: fixed in #747 |
| `403c3e8` (#717) | races around acquiring the lease | (a) the freshness check after the lease: bunvex already bootstraps under the lease (`engine.ts`, `bootstrap.ts`). (b) the read-only check inside the lease UPDATE: bunvex checks `read_only` at open (`checkStore`) and its lease UPDATE does not, so a flag set between open and `Engine.init` is missed | **affected, part (b)**: fixed in #748 (the refusal stays `ReadOnlyError`: DV-505, owner 2026-10-19) |
| `1a9f5e1` (#711) | retry deadlocked commit batches | bunvex's committer retries a flush only on `isTransient`, which MySQL errno 1213 is not: a deadlock between a flush and retention or the index worker fail-stops the committer. Less likely than in Convex (one flush at a time, DV-152) | **affected (MySQL)**: fixed in #746 |
| `d62e1c7` (#712) | comments around data sync | comments, docs and API descriptions only; bunvex already behaves as they describe (`data-sync.ts`) | **not applicable**: no change |

Each fix ships in its own PR, with its own test and sabotage check, without waiting for the next bump.

## 6. Owner decisions (2026-10-19)

| # | Question | Decision |
|---|---|---|
| Q1 | `MissingEnvironmentVariables` names `convex.config.ts` in Convex's CLI; bunvex's names `bunvex.config.ts`. A new divergence? | Covered by DV-494 (the file an app writes is `bunvex.config.ts`). **No new DV.** |
| Q2 | `_system/frontend/indexes:backfilling` (the health page's backfill progress, `076c52c`) is missing from bunvex; only Convex's health page uses it, behind a flag its self-hosted dashboard turns off. Match it now? | **Wait** until bunvex's dashboard gets a deploy-progress line. Recorded as a gap, not built now. |
| Q3 | Convex prints the dashboard line for every named local deployment; bunvex prints it only while a dashboard is served (DV-477). | **DV-477 stays as it is.** No new DV. |

No pending divergence comes out of this bump.

## 7. Tests

- §4's tests, red before and green after the change, with the sabotage checks above.
- **Differential (STUDY-122) against `precompiled-2026-10-10-72ce13c`:** `bun run test:differential` passes, 176 tests
  across 40 files with no difference, and 1500 generated programs (`DIFF_SEED=7 DIFF_RUNS=1500`) agree. No test
  changed result with the new oracle, so no behaviour change in Convex's binary needs aligning or recording.

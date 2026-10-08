# STUDY-138 — Following Convex: daily triage, weekly bump

- **Status:** accepted (owner, 2026-10-08: "sim" to the daily triage and the weekly bump); built in this PR.
- **Convex source read:** get-convex/convex-backend `main` at `a4ad353` (2026-10-08): its commit history since
  2026-09-01 and its `precompiled-*` release tags.
- **Related:**
  - [STUDY-137](STUDY-137-convex-reference-2026-10-07.md): the first bump done this way, by hand.
  - [STUDY-122](STUDY-122-differential-testing.md): the differential oracle, which pins a release.
  - [docs/parity/upstream.md](../parity/upstream.md): the state this process keeps.

## 1. How Convex changes

- **Pace.** From 2026-09-01 to 2026-10-08 Convex landed 401 commits on `main` in 23 active days, about 17 a
  day. In STUDY-137's range, about one commit in two touched the runtime, the CLI or the npm package; the rest
  were docs, demos, the cloud dashboard and cloud-only crates.
- **Releases.** Convex publishes a `precompiled-<date>-<sha>` GitHub release of the local backend several times a
  day (seven on 2026-10-07). Each is a commit of `main`.
- **Where the changes land**, from 2026-09-15 by files touched:
  - most often: `npm-packages/docs`, `npm-packages/dashboard`, `npm-packages/convex`, `crates/database`,
    `crates/isolate`, `crates/search`, `npm-packages/udf-runtime`, `crates/common`, `crates/mysql`;
  - cloud-only crates appear too, e.g. `managed_export` and `ai_gateway_jwt`.
- **What a change can be:**
  - a bug fix (3071059 skipped documents when paging over pending writes, found by our nightly as #504);
  - a new limit or knob (75d250e, rows per second);
  - a message change (b352fab);
  - part of a feature built over several commits (fb75332, `ctx.storage.store()` in mutations, "[3/n]").

## 2. What it means for bunvex

- **Urgent changes cannot wait a week.** A correctness fix in Convex's engine may mean bunvex has the same bug.
  STUDY-137 found one (c04e2f7) and pinned another as a test (aad76a4).
- **Most changes can wait for a batch.** A message, a limit or a Web API detail is aligned more cheaply in one
  weekly PR, with one oracle bump and one differential run, than commit by commit.
- **Features need the owner.** They go through a study and a decision, as everything else does (CLAUDE.md).

## 3. How bunvex does it

**Daily: the triage** (`scripts/upstream-triage.ts`, `.github/workflows/upstream-triage.yml`)
- Every day at 06:47 UTC, the workflow clones Convex's repository without file contents (history and paths
  only) and lists the commits after the reference commit recorded in `docs/parity/upstream.md`.
- It sorts each commit:
  - **urgent**: it touches the engine, the runtime or the client package's core (database, isolate, udf, value,
    common, model, application, sync, search, indexing, storage, the drivers, the client's server, values,
    browser and react code), and its subject reads as a fix, a revert, a restore or a security change;
  - **weekly**: anything else an app or an operator can observe (runtime crates, the client package and CLI, the
    web runtime, the self-hosted dashboard);
  - **ignored**: docs, demos, tests, lockfiles and cloud-only crates.
- The digest goes into one issue, rewritten every day. Each urgent commit gets its own issue, once, even after
  it is closed.
- Tried on STUDY-137's range (`4577b90..d8bdde0`, 138 commits), the script marked 7 urgent: aad76a4, c04e2f7,
  5d86d9f, 4f87cc3, b352fab, aab5a04 and 3071059. That is every fix the manual classification found that
  mattered, and nothing else. It marked 94 for the week and 37 ignored. The classification by hand counted 72
  runtime-relevant commits, so the script is wider, on purpose. The weekly bump is the filter that decides.

**Urgent issues**
- Studied the same day they open.
- If bunvex has the bug or the behaviour, the fix ships on its own PR, with a test and a sabotage check.
- If not, the issue says why and is closed.

**Weekly: the bump PR**
- The steps are listed in `docs/parity/upstream.md`.
- It moves the reference to the latest `precompiled-*` release, because the differential oracle needs its
  binary.
- It goes through every runtime commit by hand, starting from the digest, and writes a study with the
  per-commit table.
- It aligns the clear items, records new divergences as pending for the owner, moves the oracle, runs the
  differential suite, and updates `upstream.md` and the parity references.

**Features** get their own study, decision and PR, outside the bump.

## 4. Divergences

None: this is process, not behaviour.

## 5. Tests

- `scripts/upstream-triage.test.ts`: the path areas, the urgent and weekly rules, the reference read from
  `upstream.md`, and the digest's format.
- Sabotage: an urgent rule that marks nothing urgent fails two of the tests.
- The workflow runs on a pull request that changes it, the script or `upstream.md`, and only prints the digest.

## 6. Open questions

- Should the urgent rule widen, for example to every commit in `crates/database`, if a fix slips through with a
  subject that does not read as one? Revisit after a month of digests.
- Should the weekly bump be a scheduled job that opens a draft PR with the oracle moved and the differential
  run done, leaving the per-commit study to a session? Not yet: the study is most of the work.

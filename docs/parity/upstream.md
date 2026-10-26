# Following Convex

bunvex matches Convex as Convex keeps changing. This file holds where bunvex stands against
get-convex/convex-backend, and the process that keeps it there. The process is described in
[STUDY-138](../study/STUDY-138-following-convex.md).

## Where we stand

- **Reference commit:** `72ce13c`, the commit of the release `precompiled-2026-10-10-72ce13c` (2026-10-09). The parity
  files cite `4577b9031` brought up to this commit.
- **Differential oracle:** `precompiled-2026-10-10-72ce13c` (`packages/differential/scripts/download-convex-backend.sh`).
- **Last weekly bump:** [STUDY-173](../study/STUDY-173-convex-reference-2026-10-10.md) (2026-10-19), from `d8bdde0`.

## Other repositories

Convex's libraries and components live outside convex-backend. bunvex's `@bunvex/testing`, `@bunvex/helpers` and
own components are written from scratch against these repositories ([STUDY-158](../study/STUDY-158-own-components.md)).
Each one is read at the commit below, cloned next to bunvex (`~/sandbox/<clone>`). A study that moves a commit
records the move here.

| Repository | Clone | Commit | Version | For |
|---|---|---|---|---|
| get-convex/convex-test | `convex-test` | `8fe3dda` (2026-10-15) | 0.0.62 | `@bunvex/testing` |
| get-convex/convex-helpers | `convex-helpers` | `e48f9df` (2026-10-19) | 0.1.128 | `@bunvex/helpers` |
| get-convex/sharded-counter | `convex-sharded-counter` | `d8f0718` (2026-10-14) | 0.2.3 | `@bunvex/sharded-counter` |
| get-convex/batch-worker | `convex-batch-worker` | `f299a7b` (2026-10-14) | 0.3.6 | `@bunvex/batch-worker` |
| get-convex/rate-limiter | `convex-rate-limiter` | `dee5af1` (2026-10-15) | 0.4.2 | `@bunvex/rate-limiter` |
| get-convex/workpool | `convex-workpool` | `fe6f2b8` (2026-10-15) | 0.4.14 | `@bunvex/workpool` |
| get-convex/aggregate | `convex-aggregate` | `5a72b01` (2026-10-15) | 0.3.3 | `@bunvex/aggregate` |
| get-convex/migrations | `convex-migrations` | `dc87b03` (2026-10-15) | 0.3.7 | `@bunvex/migrations` |

These are not triaged daily. Each piece's study reads its repository's changes since its commit before it is
built, and moves the commit.

## The process

**Every day**, the workflow `upstream-triage.yml`:
- lists Convex's commits after the reference commit;
- sorts them with `scripts/upstream-triage.ts`.

What it does with them:
- It keeps one issue, "Convex upstream: commits since the reference", up to date with the digest.
- It opens an issue for each **urgent** commit. A commit is urgent when it is a fix, revert or security change in
  the engine, the runtime or the client package.
- An urgent issue is studied at once. If bunvex has the bug, the fix ships on its own PR, without waiting for the
  weekly bump.

**Every week**, a bump PR, as STUDY-137 did:
1. Take the latest `precompiled-*` release. The oracle needs its binary, so the reference only moves to a release.
2. Go through every runtime commit after the reference, by hand. The daily digest is the starting list.
3. Align what is clear: messages, limits and small fixes. Each comes with a test and a sabotage check.
4. Record each new difference as a pending divergence for the owner (`divergences.md`). A commit left out because it
   needs components (DV-55) goes to the list in [STUDY-62 §7.6](../study/STUDY-62-components.md#76-convex-commits-to-take-with-components),
   so it is not lost when this file's table is cleared: that list is where building components starts.
5. Move the oracle, run the differential suite, and update this file and the parity references.

**New features** are not part of the weekly bump. Each one gets its own study and the owner's decision, then its
own PR (CLAUDE.md).

## Carried to the next bump

Commits up to the reference that the last bump did not cover: none. STUDY-173 resolved the 11 that STUDY-137 carried;
`f9b2d83` (components, DV-55) is on [STUDY-62 §7.6](../study/STUDY-62-components.md#76-convex-commits-to-take-with-components).

## After the reference

195 commits on Convex's `main` follow `72ce13c` up to the release `precompiled-2026-10-24-bb31399` (2026-10-24), the
82 that the daily digest issue (#549) listed and 113 more. [STUDY-186](../study/STUDY-186-convex-after-72ce13c.md)
triages every one: 19 items to align, four new features for their own studies, six owner questions. The 3 commits
up to `precompiled-2026-10-26-04d2f3b` change nothing an app observes, and
[STUDY-193](../study/STUDY-193-convex-upstream-04d2f3b.md) plans the move to that release and tracks which of
STUDY-186's items are built. The four urgent ones were studied at
once ([STUDY-173 §5](../study/STUDY-173-convex-reference-2026-10-10.md#5-after-the-reference-the-urgent-commits)):

| Commit | Subject | bunvex |
|---|---|---|
| `8449d41` | allow repeated pagination in mutations | affected; fixed in #747 (#718) |
| `403c3e8` | races around acquiring the lease | part (b), the read-only check, affected; fixed in #748 (the refusal stays `ReadOnlyError`: DV-505, owner 2026-10-19) (#717) |
| `1a9f5e1` | retry deadlocked commit batches | affected on MySQL; fixed in #746 (#711) |
| `d62e1c7` | comments around data sync | comments only: no change (#712) |

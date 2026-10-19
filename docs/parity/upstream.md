# Following Convex

bunvex matches Convex as Convex keeps changing. This file holds where bunvex stands against
get-convex/convex-backend, and the process that keeps it there. The process is described in
[STUDY-138](../study/STUDY-138-following-convex.md).

## Where we stand

- **Reference commit:** `72ce13c`, the commit of the release `precompiled-2026-10-10-72ce13c` (2026-10-09). The parity
  files cite `4577b9031` brought up to this commit.
- **Differential oracle:** `precompiled-2026-10-10-72ce13c` (`packages/differential/scripts/download-convex-backend.sh`).
- **Last weekly bump:** [STUDY-173](../study/STUDY-173-convex-reference-2026-10-10.md) (2026-10-19), from `d8bdde0`.

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

82 commits on Convex's `main` follow `72ce13c` (up to `95d8719`, 2026-10-16). They are not triaged yet: the daily
digest issue (#549) tracks them, and the next bump takes them up to its release. The four urgent ones were studied at
once ([STUDY-173 §5](../study/STUDY-173-convex-reference-2026-10-10.md#5-after-the-reference-the-urgent-commits)):

| Commit | Subject | bunvex |
|---|---|---|
| `8449d41` | allow repeated pagination in mutations | affected; fixed in #747 (#718) |
| `403c3e8` | races around acquiring the lease | part (b), the read-only check, affected; fixed in #748 (the refusal stays `ReadOnlyError`: DV-505, owner 2026-10-19) (#717) |
| `1a9f5e1` | retry deadlocked commit batches | affected on MySQL; fixed in #746 (#711) |
| `d62e1c7` | comments around data sync | comments only: no change (#712) |

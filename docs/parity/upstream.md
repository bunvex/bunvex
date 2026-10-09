# Following Convex

bunvex matches Convex as Convex keeps changing. This file holds where bunvex stands against
get-convex/convex-backend, and the process that keeps it there. The process is described in
[STUDY-138](../study/STUDY-138-following-convex.md).

## Where we stand

- **Reference commit:** `d8bdde0`, the commit of the release `precompiled-2026-10-07-d8bdde0` (2026-10-07). The parity
  files cite `4577b9031` brought up to this commit.
- **Differential oracle:** `precompiled-2026-10-07-d8bdde0` (`packages/differential/scripts/download-convex-backend.sh`).
- **Last weekly bump:** [STUDY-137](../study/STUDY-137-convex-reference-2026-10-07.md) (#512, 2026-10-08), from
  `4577b90`.
- **Decisions waiting on the owner from the bumps:** DV-435–DV-439 (STUDY-137 §4).

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

Commits after the reference that the last bump did not cover:

| Commit | Subject | Note |
|---|---|---|
| `f9b2d83` | component-scoped custom-role statements | Components (DV-55) |
| `900fe2c` | database: check writes against staged validators, recording into validation progress | Staged validators (DV-438) |
| `e748f4c` | Fix FormData non-string values and set() with repeated names | Web API, Bun's (DV-164) |
| `a4ad353` | docs: Update function bundle size limits | Docs only (its limits taken in #539) |
| `e049178` | schema worker: validate staged validators in the background | Staged validators (DV-438) |
| `7236c10` | staged validated validators replace the walk at promotion; table deletion invalidates references | Staged validators (DV-438); first in `precompiled-2026-10-08-076c52c` |
| `02fe59b` | docs: AI Gateway model list | Docs only |
| `56a59a9` | docs: AI gateway voice | Docs only |
| `5b65aed` | evaluate_schema: staged validator state, promotion skip and discard prediction | Staged validators (DV-438 PR 6); the CLI consumer is not released yet |
| `c178e47` | Require published MySQL v6 buckets before index displacement | Convex's MySQL v6 writer only: nothing an app or bunvex's store observes |
| `076c52c` | dashboard: schema validation and index backfill progress on the health page | Dashboard, behind a flag: taken when bunvex's dashboard runs on a real deployment (DV-189) |

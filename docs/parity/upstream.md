# Following Convex

bunvex matches Convex as Convex keeps changing. This file holds where bunvex stands against
get-convex/convex-backend, and the process that keeps it there. The process is described in
[STUDY-138](../study/STUDY-138-following-convex.md).

## Where we stand

- **Reference commit:** `04d2f3b`, the commit of the release `precompiled-2026-10-26-04d2f3b` (2026-10-26). The parity
  files cite `4577b9031` brought up to this commit.
- **Differential oracle:** `precompiled-2026-10-26-04d2f3b` (`packages/differential/scripts/download-convex-backend.sh`),
  the reference's release. The suite's `convex` client is 1.48.0, the one that release ships; `sync-e2e` keeps the
  1.46.0 floor (STUDY-193 Q2).
- **Last weekly bump:** [STUDY-193](../study/STUDY-193-convex-upstream-04d2f3b.md) (2026-10-27), from `72ce13c`, with
  the triage of [STUDY-186](../study/STUDY-186-convex-after-72ce13c.md).

## Other repositories

Convex's libraries and components live outside convex-backend. bunvex's `@bunvex/testing`, `@bunvex/helpers` and
own components are written from scratch against these repositories ([STUDY-158](../study/STUDY-158-own-components.md)).
Each one is read at the commit below, cloned next to bunvex (`../<clone>`). A study that moves a commit
records the move here.

| Repository | Clone | Commit | Version | For |
|---|---|---|---|---|
| get-convex/convex-test | `convex-test` | `8fe3dda` (2026-10-15) | 0.0.62 | `@bunvex/testing` |
| get-convex/convex-helpers | `convex-helpers` | `e48f9df` (2026-10-19) | 0.1.128 | `@bunvex/helpers` |
| get-convex/sharded-counter | `sharded-counter` | `d8f0718` (2026-10-14) | 0.2.3 | `@bunvex/sharded-counter` |
| get-convex/batch-worker | `batch-worker` | `f299a7b` (2026-10-14) | 0.3.6 | `@bunvex/batch-worker` |
| get-convex/rate-limiter | `rate-limiter` | `dee5af1` (2026-10-15) | 0.4.2 | `@bunvex/rate-limiter` |
| get-convex/workpool | `workpool` | `fe6f2b8` (2026-10-15) | 0.4.14 | `@bunvex/workpool` |
| get-convex/aggregate | `aggregate` | `5a72b01` (2026-10-15) | 0.3.3 | `@bunvex/aggregate` |
| get-convex/migrations | `migrations` | `dc87b03` (2026-10-15) | 0.3.7 | `@bunvex/migrations` |
| get-convex/templates | `convex-templates` | `34364d1` (2026-10-29) | — | the examples after Convex's app templates (`template-tanstack-start`: STUDY-198) |

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

Commits up to the reference that the last bump did not build, each with its own study:
- STUDY-186 §4.2's new features: storage in mutations (no study yet), the CLI's staged-schema output (`4f81b22`),
  and `v.function()` (waits for Convex's client). `ctx.auth.signJwt` and `/.well-known/jwks.json` are built
  ([STUDY-192](../study/STUDY-192-sign-jwt.md), #937).
- STUDY-186 Q6, Bun's Brotli and root store: a check outside parity, not recorded yet.
- `f9b2d83` (components, DV-55) is on [STUDY-62 §7.6](../study/STUDY-62-components.md#76-convex-commits-to-take-with-components).

## After the reference

Not built yet: the next weekly bump starts from `04d2f3b`. The daily digest (issue #549) lists the commits since;
on 2026-10-28 these touch what bunvex matches:
- `11e4a17` removes the Vitess-only MySQL handling: error 1105 is operational only for "connection timed out", where
  bunvex's MySQL driver (`mysql.ts`, `operational`) still accepts Convex's four old messages;
- `bdee40a` frees a transaction's read set off the committer thread (performance only);
- `8b36630` reworks streams in the isolate's HTTP and storage ops;
- `aa977e2` runs a local backend's Node actions with the `node` on `PATH` (bunvex runs them in Bun, DV-87);
- `6f2292f` requires Node.js 22 in the `convex` package, and `62241ac` adds `npx convex plugins install` (CLI);
- `2605da1`, `a3099d8` and `72057d6` mirror V5 MySQL deployments into a V6 replica (cloud-only, opt-in).

STUDY-186's A1–A19 and its owner answers are built ([STUDY-193 §3](../study/STUDY-193-convex-upstream-04d2f3b.md#3-study-186-a1a19-what-is-built)).

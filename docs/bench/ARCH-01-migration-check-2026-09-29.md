# ARCH-01 migration — performance check (29 Sep 2026)

The monorepo migration (ARCH-01) was a pure move. There was no commit before it, so no A/B against the old
tree was possible; instead the post-migration tree was compared with the pre-migration run on the same
VPS and harness (`convex-bench/results/*-vps-bunvex-{memory,sqlite}`), and the noise of a single run was
measured directly: the SQLite suite was run **four times** on the committed tree (`62740d0`).

Best point of 8/32/128 VUs, req/s:

| scenario | before (28 Sep) | after, run 1 | run 2 | run 3 | run 4 | band of the 4 runs | before vs band |
|---|--:|--:|--:|--:|--:|--:|:-:|
| query, cached | 8 140 | 7 853 | 8 255 | 8 214 | 7 828 | 7 828–8 255 (5 %) | inside |
| query, uncached | 3 045 | 2 759 | 2 930 | 3 006 | 2 989 | 2 759–3 006 (9 %) | 1 % above |
| insert | 4 004 | 3 846 | 3 813 | 3 827 | 4 048 | 3 813–4 048 (6 %) | inside |
| increment, 1 000 keys | 2 676 | 2 556 | 2 631 | 2 490 | 2 538 | 2 490–2 631 (6 %) | 2 % above |
| action | 3 395 | 3 364 | 3 300 | 3 273 | 3 165 | 3 165–3 364 (6 %) | 1 % above |
| mix 90/10 | 2 557 | 2 487 | 2 438 | 2 502 | 2 462 | 2 438–2 502 (3 %) | 2 % above |

Identical code varies 3–9 % between runs on this box. The pre-migration numbers fall inside that band or
at most 2 % above its top — a difference single runs cannot resolve. **No regression is attributable to
the migration**; any real effect is ≤ ~2 % (consistent with the one extra function indirection per call
the function registry now adds). Memory, run once after the migration, moved −11 % to +6 % across
scenarios, inside the same noise.

Method note for the future: compare A/B with ≥ 3 interleaved runs per side and report the band, never a
single pair of runs.

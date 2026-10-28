# versus at 7cd25d51: Convex precompiled-2026-10-26-04d2f3b and bunvex, each on Postgres on its own droplet

server 4 vCPUs (Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz), db 4 vCPUs (Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz), load 4 vCPUs (Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz)

## HTTP: best of the VU counts (median of the repeats), req/s · p99 ms · server cores · db cores

| scenario | convex | bunvex |
|---|--:|--:|
| cached | 9005 · 32 · 3.07 · 0.01 (128 VUs) | 8457 · 32 · 0.84 · 0.02 (128 VUs) |
| uncached | 591 · 161 · 3.12 · 0.14 (32 VUs) | 2061 · 11 · 0.91 · 0.03 (8 VUs) |
| insert | 576 · 334 · 3.05 · 0.13 (128 VUs) | 2655 · 82 · 0.69 · 0.22 (128 VUs) |
| increment1000 | 484 · 219 · 2.97 · 0.33 (32 VUs) | 984 · 82 · 0.79 · 1.01 (32 VUs) |
| increment1 | 95 ⚠ · 1123 · 0.80 · 0.45 (8 VUs) | 118 ⚠ · 1094 · 0.24 · 0.81 (8 VUs) |
| action | 262 · 679 · 3.05 · 0.11 (128 VUs) | 2005 · 90 · 0.73 · 0.19 (128 VUs) |
| mix | 756 · 430 · 3.01 · 0.17 (128 VUs) | 1936 · 478 · 0.90 · 0.05 (128 VUs) |

⚠ = more than 1 % errors.

## Fan-out, splay off (SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER=0): delivered · p99 delivery · server RSS

| subscribers | convex | bunvex |
|--:|--:|--:|
| 100 | 100 % · 32 ms · 2164 MB | 100 % · 21 ms · 594 MB |
| 1000 | 100 % · 172 ms · 2687 MB | 100 % · 75 ms · 623 MB |
| 5000 | 100 % · 931 ms · 5423 MB | 100 % · 238 ms · 550 MB |
| 10000 | failed | 100 % · 443 ms · 671 MB |

## Fan-out, splay on (shipped): delivered · p99 delivery · server RSS

| subscribers | convex | bunvex |
|--:|--:|--:|
| 100 | 100 % · 41 ms · 190 MB | 100 % · 36 ms · 89 MB |
| 1000 | 53 % · 2.35 s · 679 MB | 53 % · 2.58 s · 99 MB |
| 5000 | 28 % · 5.94 s · 3208 MB | 21 % · 5.63 s · 140 MB |
| 10000 | failed | 11 % · 9.96 s · 172 MB |

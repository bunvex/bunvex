# outcome-wire (STUDY-194 §4.2), Mac M1 Pro

`bun bench/offthread/outcome-wire.ts`, 2026-10-26, Bun 1.4.4, N=20000, WINDOW=64. The 8 cores were shared with other
work (load average 17–23 during both runs): read the ratios between encodings, not the absolute values. Two runs.

Run 1 (load average 23.4):

| outcome | encoding | size | encode, worker (µs) | decode, main (µs) | per outcome across threads, main (µs) |
|---|---|---:|---:|---:|---:|
| query, 20 docs | clone | — | — | — | 6.11 |
| query, 20 docs | text | 4292 | 2.86 | 2.51 | 3.68 |
| query, 20 docs | text, docs passed on | 4303 | 3.07 | 1.95 | 3.56 |
| query, 20 docs | buffer | 4321 | 3.89 | 1.97 | 3.79 |
| query, 20 docs | hybrid | — | 1.67 | 1.55 | 4.14 |
| mutation, 1 write | clone | — | — | — | 9.25 |
| mutation, 1 write | text | 1778 | 4.83 | 3.23 | 5.55 |
| mutation, 1 write | text, docs passed on | 1790 | 4.34 | 3.68 | 5.15 |
| mutation, 1 write | buffer | 1850 | 3.81 | 3.40 | 4.92 |
| mutation, 1 write | hybrid | — | 2.67 | 2.49 | 9.18 |
| mutation, 20 writes | clone | — | — | — | 66.95 |
| mutation, 20 writes | text | 21736 | 49.18 | 41.07 | 44.02 |
| mutation, 20 writes | text, docs passed on | 21749 | 39.32 | 30.14 | 42.22 |
| mutation, 20 writes | buffer | 22618 | 47.83 | 41.70 | 46.95 |
| mutation, 20 writes | hybrid | — | 27.39 | 36.58 | 41.74 |

Run 2 (load average 17.8):

| outcome | encoding | size | encode, worker (µs) | decode, main (µs) | per outcome across threads, main (µs) |
|---|---|---:|---:|---:|---:|
| query, 20 docs | clone | — | — | — | 6.48 |
| query, 20 docs | text | 4292 | 3.33 | 1.90 | 11.00 |
| query, 20 docs | text, docs passed on | 4303 | 4.57 | 2.57 | 4.47 |
| query, 20 docs | buffer | 4321 | 5.82 | 2.06 | 4.41 |
| query, 20 docs | hybrid | — | 2.31 | 1.93 | 4.85 |
| mutation, 1 write | clone | — | — | — | 9.42 |
| mutation, 1 write | text | 1778 | 5.69 | 3.60 | 5.34 |
| mutation, 1 write | text, docs passed on | 1790 | 4.03 | 3.37 | 4.89 |
| mutation, 1 write | buffer | 1850 | 4.05 | 3.25 | 5.32 |
| mutation, 1 write | hybrid | — | 2.79 | 2.64 | 5.54 |
| mutation, 20 writes | clone | — | — | — | 70.30 |
| mutation, 20 writes | text | 21736 | 45.71 | 35.30 | 53.24 |
| mutation, 20 writes | text, docs passed on | 21749 | 40.27 | 30.05 | 40.43 |
| mutation, 20 writes | buffer | 22618 | 52.05 | 44.27 | 47.99 |
| mutation, 20 writes | hybrid | — | 35.18 | 26.38 | 38.67 |

The single outliers (text 11.00, hybrid 9.18) did not repeat in the other run.

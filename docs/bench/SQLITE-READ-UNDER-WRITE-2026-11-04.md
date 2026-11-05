# Reads under write load on SQLite (audit P1), 2026-11-04

**Question (audit decision 2, owner 2026-11-04).** Since STUDY-190 PR 1, SQLite's writes run on a writer thread,
which is a second connection. SQLite drops a connection's page cache whenever another connection has committed
since that connection's last read. The performance audit measured 0 page-cache hits in 800 reads on the reader
connection right after foreign commits (a raw probe on two FFI connections). So, under writes, the 256 MiB cache of
DV-550 may do nothing. Before changing anything, the owner asked for a measurement on bunvex's real read path.

**Bench.** `bench/sqlite-read-under-write.ts`. It uses the engine on a durable SQLite file, with the writer thread.
- **Store:** 200 000 documents of about 1 KB, roughly 220 MB, past the 2 MiB cache and under the 256 MiB one.
- **Readers:** 16 query loops: half random `db.get`, half 20-document `by_n` ranges.
- **Writers:** 8 mutation loops sharing a target rate of 0, 50 or 500 commits a second. Each patches another table,
  so the documents read never change.
- **Each cell:** its own process, starting from a fresh copy of the store, then 2 s of warm-up and 12 s measured.
- **Varied:** the page cache (2 MiB, 256 MiB), `mmap_size` (0, 1 GiB) and the index cache (off, on).

**Machine.** Apple M1 Pro, 8 cores, 16 GB, macOS. The store fits in the OS page cache.
- With `synchronous=full`, the fsyncs capped commits at about 110–150 a second, so "500" means "as many as the
  disk allows".
- DV-550 was measured on a 2-vCPU Linux VPS, with a 10 GB store and a 200 MB one. These numbers are not that
  machine's.

## Results

| index cache | commits/s | page cache | mmap | reads/s | p50 ms | p99 ms |
|---|---|---|---|---|---|---|
| off | 0 | 2 MiB | 0 | 13 813 | 0.087 | 0.316 |
| off | 0 | 256 MiB | 0 | 13 723 | 0.085 | 0.316 |
| off | 0 | 2 MiB | 1 GiB | **19 526** | 0.073 | **0.113** |
| off | 49 | 2 MiB | 0 | 13 746 | 0.086 | 0.309 |
| off | 49 | 256 MiB | 0 | 13 392 | 0.086 | 0.326 |
| off | 51 | 2 MiB | 1 GiB | **17 087** | 0.076 | **0.139** |
| off | 122 | 2 MiB | 0 | 13 481 | 0.087 | 0.315 |
| off | 121 | 256 MiB | 0 | 13 458 | 0.085 | 0.320 |
| off | 152 | 2 MiB | 1 GiB | **16 514** | 0.076 | **0.137** |
| on | 0 | 2 MiB | 0 | 12 332 | 0.032 | 0.344 |
| on | 0 | 256 MiB | 0 | 12 091 | 0.036 | 0.349 |
| on | 0 | 2 MiB | 1 GiB | **16 099** | 0.027 | **0.173** |
| on | 49 | 2 MiB | 0 | 12 211 | 0.033 | 0.335 |
| on | 49 | 256 MiB | 0 | 12 292 | 0.033 | 0.344 |
| on | 50 | 2 MiB | 1 GiB | **14 799** | 0.029 | **0.171** |
| on | 112 | 2 MiB | 0 | 12 071 | 0.033 | 0.347 |
| on | 107 | 256 MiB | 0 | 12 056 | 0.033 | 0.350 |
| on | 143 | 2 MiB | 1 GiB | **14 500** | 0.029 | **0.165** |

## What it shows

1. **On this machine, the page cache's size changes nothing, with or without writes.** 2 MiB and 256 MiB are
   within 2.5 % of each other in every pair, including the cells with no writes at all, where no cache is ever
   dropped. Here the read path is bound by the engine's own work (about 70 µs a read), not by SQLite finding its
   pages. So this machine can neither show DV-550's gain nor P1's loss of it.
2. **`mmap_size` is the clear winner: +23–41 % reads a second, and p99 −50 to −64 %.**
   - With mmap, SQLite reads the file's pages from the mapped file in place, with no `read()` call and no copy into
     its cache. A cache dropped after a foreign commit then costs little.
   - Its gain shrinks under writes (+41 % with none, +23 % at the disk's limit). That is the reader re-reading the
     WAL, which mmap does not cover.
   - Convex sets no `mmap_size`, so turning it on would be a divergence (operational, unobservable by apps).
   - **Caveat:** an I/O error on a mapped page reaches the process as a signal (SIGBUS) instead of an `SQLITE_IOERR`
     the store can report. The backend would crash where today it fails the read. For a disk that is failing, both
     end in a restart, but the crash says less.
3. **The index cache lowers p50 (0.03 against 0.09 ms) but not throughput** on this uniform random read over
   200 000 documents, which it mostly misses. That is expected, and it is not P1's subject.

## On the VPS DV-550 was measured on (2026-11-05)

**Machine.** The test VPS: Hostinger KVM2, 2 vCPU AMD EPYC 9354P, 8 GB, Ubuntu 24.04 (kernel 6.8), a cloud SSD, Bun
1.4.3, nothing else running. bunvex at `963d35aa` (main after #1057).
- With `synchronous=full`, the disk caps commits at about 30 a second, so the "50" and "500" targets both mean
  "as many as the disk allows".

### Small store (200 000 documents, about 220 MB): five rounds

These are the cells that matter: the reads are CPU-bound and their working set is past 2 MiB and under 256 MiB, the
case where DV-550 found the default about 15–22 % slower. The run used the index cache on (the default), and
`CELLS` with the three configurations in a different order in each round (ABC, CBA, BAC, CAB, BCA). It was one
process for each of the 30 cells, each from a fresh copy of the store.

| commits/s | config | reads/s, five rounds | median | p99 median, ms |
|---|---|---|---|---|
| 0 | 2 MiB | 4 065 · 4 298 · 4 298 · 4 298 · 4 356 | 4 298 | 0.747 |
| 0 | 256 MiB | 4 538 · 4 421 · 4 086 · 4 381 · 4 435 | 4 421 (+3 %) | 0.602 |
| 0 | 2 MiB + mmap 1 GiB | 4 920 · 4 031 · 4 843 · 4 956 · 3 972 | 4 843 (+13 %) | 0.557 |
| ~31 | 2 MiB | 3 925 · 4 260 · 4 005 · 3 811 · 4 173 | 4 005 | 0.881 |
| ~30 | 256 MiB | 4 048 · 3 749 · 3 734 · 3 861 · 3 764 | 3 764 (−6 %) | 0.833 |
| ~31 | 2 MiB + mmap 1 GiB | 3 871 · 3 515 · 4 026 · 4 007 · 3 455 | 3 871 (−3 %) | 0.683 |

A first pass of the whole matrix (one round a cell) had shown 256 MiB up to 27 % behind 2 MiB. The five rounds show
that this was noise: a cell's spread across rounds is about 10 %.

### Big store (2 000 000 documents, about 2.2 GB, in a scope of `MemoryMax=2G`)

The whole matrix, one round. With the store past its memory, every read waits on the disk. The figures are 117–308
reads a second, p99 15–49 ms, and 1–3 commits a second, with no order between the configurations: 2 MiB, 256 MiB
and mmap each land both at the top and at the bottom. This is the case where DV-550 itself found no gap ("no gap
when the disk is the bottleneck").

### What it shows

1. **The 256 MiB cache no longer buys anything measurable on bunvex's read path.** Without writes it is +3 %, and
   under writes it is −6 %. Both are inside the noise. DV-550's 15–22 % does not reproduce. The engine now has the
   index cache in front of SQLite, and its own work per read dominates, as on the Mac.
2. **Under writes, P1's mechanism is real but costs little.** The reader's cache is dropped after the writer
   thread's commits, which is why 256 MiB falls from +3 % to −6 %. But the loss is no bigger than the noise.
3. **mmap helps only without writes** (+13 % reads, p99 −25 %). Under writes it is −3 % (noise), because the reader
   re-reads the WAL, which mmap does not cover. On a live store, which always has writes, that is no gain worth a
   divergence with the SIGBUS caveat.
4. The memory used is within the noise as well (RSS medians 770–883 MB).

### The choice (owner)

- (a) Keep 256 MiB (DV-550 stays).
- (b) Go back to Convex's default, SQLite's 2 000 KiB, and close DV-550. This bench finds no gain to keep.
- (c) Propose `mmap_size` as a divergence. This bench finds a gain only without writes.

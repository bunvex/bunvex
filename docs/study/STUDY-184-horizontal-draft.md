# STUDY-184 — horizontal scaling, the Linux measurements before any follower

- **Status:** draft. No product change. [STUDY-24](STUDY-24-horizontal-scaling.md) H1–H12 stay as the owner
  decided them. This study records what has to be measured on Linux before a follower exists.
- **Convex source read:** not re-read. Convex Cloud's shape is STUDY-24 §1.3: one committer per deployment,
  function execution and WebSockets scaled beside it. Self-hosted Convex is one process.
- **Related:** STUDY-24, DV-113–DV-121, the VPS table in
  [E2E-VPS-2026-10-05](../bench/E2E-VPS-2026-10-05.md)

## 1. What is already decided and built

One deployment keeps one committer. Extra processes take reads, sockets and, later, function execution.
Mutations are forwarded to the leader first (A1). Execution on the follower with the leader's begin
timestamp (A2) comes after that. Memory and SQLite stay one node. Postgres, MySQL and MongoDB are the
stores that can have followers.

Already in the product, and left as they are:

- the lease, so a second process on the same store is refused instead of writing;
- the document log by timestamp, so a follower can catch up;
- the time-based OCC window an off-leader execution needs;
- index backfill in the background, so a new leader does not stall writes.

Not built: a follower process, mutation forwarding, off-leader execution, the commit stream, the read-index
round trip, and SCALE-01.

## 2. What an app must still observe

A draft that fails any of these stops.

- A mutation the client was told succeeded is durable, and a later query sees it.
- A cached page is invalidated by that write.
- Two processes never commit to the same store. The lease already refuses the second.
- A follower does not acknowledge a write the leader has not flushed.
- Failover loses nothing that was acknowledged. STUDY-24 measured that on a throwaway spike; the product
  has no failover path yet.
- Logs, metrics and usage limits stay on.

## 3. The box

The owner's test VPS, inspected 23 Oct 2026: Linux 6.8, 2 CPUs, 7.8 GiB, Bun and Docker installed, ssh
the only public listener. Same class of machine as the 5 Oct bench (2 vCPU, 8 GB, real fsync). On that
bench one bunvex process did about 6 000 cached queries/s and about 3 300 Postgres inserts/s.

Two cores decide what this box can answer. STUDY-24 §4.7, on an 8-core Mac, saw cached reads at 1.5× with
2 processes and 1.7× with 6, and told a 2-vCPU deployment to let the leader serve traffic too. This VPS
can check the Linux port split and a 1-process against 2-process ceiling. It cannot stand in for a
6-process or multi-machine run.

## 4. Measurement 1 — one port, two processes

`bun bench/scale/reuse-port.ts`. Two processes bind `127.0.0.1` with `reusePort`. Each response is the
process id. No store is opened. 23 Oct 2026:

| where | requests | process 0 | process 1 | balance (min/max) |
|---|---:|---:|---:|---:|
| this Mac | 200 | 0 | 200 | 0 |
| the VPS | 400 | 195 | 205 | 0.95 |

Linux shares the connections. macOS gives them all to one process, which is what STUDY-24 §4.7 recorded.
A Bun proxy is still a one-core bottleneck there (27k req/s against 58k direct). On Linux the kernel can
spread connections, so the draft does not start by writing a proxy.

## 5. Measurement 2 — one core, then two processes

`bun bench/scale/two-read.ts`, on the VPS, 23 Oct 2026. Each server is the bench server, memory store,
its own data directory, bound to `127.0.0.1`. The cached query is `bench:listCached` after seeding one
tenant's 20 documents. The load is 32 connections in this process, 1 s of warmup, then 10 s. No failures.

| servers | req/s | server cores | client cores |
|---|---:|---:|---:|
| 1 | 8 130 | 1.01 | 0.58 |
| 2 | 9 717 | 0.68 + 0.68 | 0.54 |

Two processes are 1.19×, not 2×. One server already held a whole core, and the client held most of the
other. The second server took core away from the first (1.01 became 0.68 + 0.68) and the sum of reads
rose by about a fifth. On this 2-core box a follower beside a busy leader does not multiply cached reads.
STUDY-24's advice stands: with 2 vCPUs the leader serves traffic too.

The absolute 8 130 is not the 5 Oct figure (about 6 000, k6, a seeded 100 000-document store). The client
and the data differ. The ratio is the result.

## 5b. The same measurement on 4 cores

A second machine, 23 Oct 2026: 4 vCPU, AMD EPYC at 2.0 GHz, 7.8 GiB, KVM. Load was about 0.3 before the
run. Docker containers were up and idle (about 1.2 GiB in use) and were left running. Bun 1.4.4 was
installed for the run. Same script, localhost only, no failures.

| connections | servers | req/s | server cores | client cores |
|---|---:|---:|---:|---:|
| 32 | 1 | 3 341 | 1.16 | 0.86 |
| 32 | 2 | 3 821 | 0.91 + 0.96 | 0.67 |
| 128 | 1 | 3 944 | 1.25 | 0.92 |
| 128 | 2 | 4 105 | 1.03 + 1.07 | 0.82 |

One server already finishes about 4 000 cached reads/s and holds a little more than one core. Two cores
stay idle. A second server raises the rate by 14 % with 32 connections and by 4 % with 128. The extra
server core is busy and the responses do not come out faster: the process issuing the requests is near
one core and stays near 4 000/s.

A core here serves about half of what a core on the 2-vCPU test box served (8 130/s at one core). The
published 2.0 GHz cap is the visible difference. Free cores on this box do not multiply one deployment's
cached reads while a single client process is the one asking.

Giving each server its own client process (`SPLIT=1`, 128 connections each) does not change that. One
pair did 3 513/s (server 1.41 cores, client 0.97). Two pairs at once did 1 802 + 1 606 = 3 408/s, with
the servers at 1.24 and 1.14 cores and the clients at 0.56 and 0.45. No failures. The cores were busy
and the building's total stayed the same: each shop received about half. Spare cores on this machine do
not become extra cached reads.

## 6. What gets measured next, before any follower code

Each step is a number with the guarantees of §2 still holding. A step that does not pay for itself stops
the draft. Step 1 below is done (§5): two processes did not pay for themselves on this box.

1. **Two independent processes, cached reads, separate memory stores, two ports.** Done. 8 130 req/s with
   one server, 9 717 with two (§5).
2. **One process, the current server, memory and Postgres.** The denominator for later runs, next to the
   5 Oct table. Postgres stays a database created for the run. The lease stays on. Worth doing before any
   forwarding experiment, and it does not need a second core.
3. **Throwaway A1.** Followers forward inserts to one leader over a local socket, the shape that measured
   +55% on the Mac (18k to 28–29k) because the leader stopped parsing HTTP. On this box the spare core is
   already small (§5), so the gain should be smaller still. The leader is the only committer. A follower
   that flushes on its own fails the test.
4. **Reads and subscriptions on a follower** that applies the leader's commit stream and does not serve a
   page older than a write the client was told succeeded. Not on this 2-core box as a throughput bet.

## 6b. One process on the Hostinger box, 23 Oct 2026

The 2-vCPU EPYC 9354P, k6 on the box, 10 s, the bench seed (100 000 items). One server. No failures.
Postgres 17 was a new container on `127.0.0.1` with default durability, removed after the run. The 5 Oct
table was 20 s, best of 8/32/128, k6, on a Postgres that box already had.

| | 5 Oct | today, 32 | today, 128 | server cores at 128 |
|---|---:|---:|---:|---:|
| memory, cached | 5 953 | 7 118 | 7 513 | 0.77 |
| memory, insert | 3 861 | 2 738 | 3 918 | 1.00 |
| postgres, cached | 5 925 | 6 990 | 5 574 | 0.73 |
| postgres, insert | 3 281 | 1 517 | 2 225 | 0.67 |

Memory inserts match 5 Oct (3 918 against 3 861). Cached reads are higher. Postgres inserts are lower and
the server core is not full, so the wait is this fresh database, not a second process. One shop on this
CPU is where the 5 Oct insert number already was.

The same insert, still one process, with that container on the host network instead of a published port
(`--network host`, listen `127.0.0.1` only, same image, default durability: fsync on, synchronous commit
on, shared buffers 128 MB). Seed 18.0 s. No failures.

| | 32 VU | 128 VU | server cores at 128 | postgres cores at 128 |
|---|---:|---:|---:|---:|
| postgres insert, published port | 1 517 | 2 225 | 0.67 | — |
| postgres insert, host network | 672 | 1 720 | 0.70 | 0.27 |

Host network does not recover the 5 Oct insert (3 281). The server stays near 0.7 cores and Postgres
itself near 0.3, so the wait is the fresh database's flush, not the Docker port hop. The 5 Oct number
was the instance that box already had.

A2, off-leader execution, waits until A1's numbers and the read-your-writes checks exist. Sharding the
committer stays out, as STUDY-24 recommended.

## 7. Divergences

None proposed here.

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | — | — | — |

## 7b. Additions

None.

| # | Addition | Why | Decision |
|---|---|---|---|
| — | — | — | — |

#!/bin/bash
# STUDY-174 Q6's matrix, as run on the test VPS (2 vCPU, 8 GB, Ubuntu 24.04, cgroup v2), as root, from a copy of the
# repository (never a checkout you commit from: it patches the store's pragma, see ./patch-backend.ts).
#
#   bash bench/sqlite-cache/vps.sh <work dir>
#
# Two stores, seeded once each through the real backend:
#   big:   5 M documents (~10 GB, more than the machine's RAM), the backend limited to MemoryMax=2G, OS page
#          cache included: the file is 5x what it may cache;
#   small: 100 k documents (~200 MB), no limit: the file fits the 256 MiB cache and the OS page cache.
# Each store, each mode (uniform: every group; hot: 2 % of them), runs both caches in ABBA order (the big store's hot mode twice: 90 s and 300 s warm-ups), so a drift over
# time (the disk, the other tenant) does not side with one. Results: <work dir>/results/*.json.
set -euo pipefail
WORK=${1:?work dir}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BENCH="bun $REPO/bench/sqlite-cache/bench.ts"
mkdir -p "$WORK/results"
bun "$REPO/bench/sqlite-cache/patch-backend.ts" "$REPO"

[ -f "$WORK/big/meta.json" ] || $BENCH seed --state "$WORK/big" --docs 5000000
[ -f "$WORK/small/meta.json" ] || $BENCH seed --state "$WORK/small" --docs 100000
# A store seeded before the seed settled its table summary checkpoint (bench.ts `settle`) gets it here.
for store in big small; do
  [ -f "$WORK/$store/settled" ] || { $BENCH checkpoint --state "$WORK/$store" && touch "$WORK/$store/settled"; }
done

run() { # store mode cache rep memory-max warmup seconds
  local out="$WORK/results/$1-$2-$3-$4.json"
  [ -f "$out" ] && return 0
  $BENCH run --state "$WORK/$1" --mode "$2" --cache "$3" --memory-max "$5" --warmup "$6" --seconds "$7" \
    --concurrency 16 --label "$1-$2-rep$4" --out "$out"
}
for store in big small; do
  if [ $store = big ]; then mem=2G warm=90 secs=180; else mem="" warm=30 secs=120; fi
  for mode in uniform hot; do
    run $store $mode default 1 "$mem" $warm $secs
    run $store $mode 262144 1 "$mem" $warm $secs
    run $store $mode 262144 2 "$mem" $warm $secs
    run $store $mode default 2 "$mem" $warm $secs
  done
done
# The big store's hot set (~200 MB) is still being read from disk after 90 s: two more pairs, warmed for 300 s, so
# the comparison is of the steady state (no disk reads left), where the cache's size matters most.
run big hot default 3 2G 300 180
run big hot 262144 3 2G 300 180
run big hot 262144 4 2G 300 180
run big hot default 4 2G 300 180
# The small store's differences are within its run-to-run spread: a second ABBA quartet per mode.
for mode in uniform hot; do
  run small $mode default 3 "" 30 120
  run small $mode 262144 3 "" 30 120
  run small $mode 262144 4 "" 30 120
  run small $mode default 4 "" 30 120
done

#!/usr/bin/env bash
# On the VPS: unpack the three trees, install, run the actions bench. Output in /root/bunvex-pr5/results.
set -u
R=/root/bunvex-pr5
mkdir -p $R/results
cd $R
for t in head c1 base; do
  if [ ! -d $t ]; then mkdir -p $t && tar -xzf $t.tgz -C $t; fi
  cp $R/actions.ts $t/packages/sandbox/bench/actions.ts
  (cd $t && bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1)
done
uptime > $R/results/uptime-before.txt
cd $R/head
bun packages/sandbox/bench/actions.ts 1000 100 "" --json > $R/results/head-1.txt 2>&1
bun packages/sandbox/bench/actions.ts 1000 100 "" --json > $R/results/head-2.txt 2>&1
taskset -c 0 bun packages/sandbox/bench/actions.ts 1000 100 "" --json > $R/results/head-pinned.txt 2>&1
cd $R/c1
bun packages/sandbox/bench/actions.ts 1000 100 "MiB" --json > $R/results/c1-bytes.txt 2>&1
cd $R/base
bun packages/sandbox/bench/actions.ts 1000 100 "" --json --vm > $R/results/base-vm.txt 2>&1
uptime > $R/results/uptime-after.txt
echo done > $R/results/DONE

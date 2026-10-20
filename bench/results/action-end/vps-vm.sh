#!/usr/bin/env bash
set -u
R=/root/bunvex-vmend; cd $R; mkdir -p results
for t in main fix; do mkdir -p $t && tar -xzf $t.tgz -C $t; cp actions.ts $t/packages/sandbox/bench/actions.ts; (cd $t && bun install >/dev/null 2>&1); done
uptime > results/uptime-before.txt
for round in 1 2; do for t in main fix; do (cd $R/$t && bun packages/sandbox/bench/actions.ts 2000 200 "" --vm --json > $R/results/$t-$round.txt 2>&1); done; done
uptime > results/uptime-after.txt; echo done > results/DONE

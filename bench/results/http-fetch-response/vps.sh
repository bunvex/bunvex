#!/usr/bin/env bash
# The runner on the test VPS: main and this change unpacked side by side, the bench copied into each, then ABAB.
set -u
R=/root/bunvex-vm-fetch-response; cd $R; mkdir -p results
for t in main fix; do mkdir -p $t && tar -xzf $t.tgz -C $t; mkdir -p $t/bench/results/http-fetch-response; cp server.ts bench.ts $t/bench/results/http-fetch-response/; (cd $t && bun install >/dev/null 2>&1); done
uptime > results/uptime-before.txt
for round in 1 2; do for t in main fix; do (cd $R/$t && bun bench/results/http-fetch-response/bench.ts 2000 200 > $R/results/$t-$round.txt 2>&1); done; done
uptime > results/uptime-after.txt; echo done > results/DONE

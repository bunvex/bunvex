#!/usr/bin/env bash
# On the VPS (STUDY-171 §14.4): this branch's tree in /root/bunvex-pr6/head2, its base (main with PR 4b) in
# /root/bunvex-pr6/base, installed. Each line runs alone on the idle machine; output in /root/bunvex-pr6/results.
set -u
R=/root/bunvex-pr6
mkdir -p $R/results
# The base runs this branch's bench under vm only (its `process` has no HTTP actions).
cp $R/head2/packages/sandbox/bench/http.ts $R/head2/packages/sandbox/bench/http-server.ts $R/base/packages/sandbox/bench/
uptime > $R/results/uptime-before.txt
ps -eo pid,pcpu,rss,etime,args --sort=-pcpu | head -8 > $R/results/ps-before.txt
cd $R/head2
bun packages/sandbox/bench/http.ts 1000 100 "" --json > $R/results/head-1.txt 2>&1
bun packages/sandbox/bench/http.ts 1000 100 "" --json > $R/results/head-2.txt 2>&1
cd $R/base
bun packages/sandbox/bench/http.ts 1000 100 "" --json --vm > $R/results/base-vm.txt 2>&1
uptime > $R/results/uptime-after.txt
echo done > $R/results/DONE

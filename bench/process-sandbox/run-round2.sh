#!/bin/bash
# STUDY-168 round 2 on the VPS (as root), one after the other: results/fixes-*.jsonl, container-rtt.jsonl, bytes.jsonl.
cd "$(dirname "$0")/../.." || exit 1
B=/root/.bun/bin/bun
O=bench/process-sandbox/results
for p in pool affinity batch neighbour; do $B bench/process-sandbox/fixes-bench.ts $p 2>&1 | grep '^{' > $O/fixes-$p.jsonl; done
$B bench/process-sandbox/container-rtt.ts sbstudy 2>&1 | grep '^{' > $O/container-rtt.jsonl
$B bench/process-sandbox/bytes-bench.ts 2>&1 | grep '^{' > $O/bytes.jsonl
SANDBOX_STUDY=1 $B test --timeout 60000 bench/process-sandbox 2>&1 | grep -E '^\((pass|fail|skip)\)|^ *[0-9]+ (pass|fail)' > $O/tests-host.txt
echo done

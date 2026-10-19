#!/bin/bash
# STUDY-168: bench.ts on the host and inside Docker, one after the other (VPS, as root).
#   bench/process-sandbox/docker/bench-docker.sh <repo dir>   -> results/bench-docker.jsonl
R=${1:?repo dir}
D=$(cd "$(dirname "$0")" && pwd)
OUT="$R/bench/process-sandbox/results/bench-docker.jsonl"
: > "$OUT"
BWRAP_OPTS="--security-opt seccomp=$D/seccomp-bwrap.json --security-opt apparmor=bunvex-sandbox --security-opt systempaths=unconfined --security-opt writable-cgroups=true"
tag() { sed -u "s/^{/{\"where\":\"$1\",/" >> "$OUT"; }
for m in vm bwrap; do (cd "$R" && /root/.bun/bin/bun bench/process-sandbox/bench.ts $m) | tag host; done
dock() { docker run --rm --init $1 -e SANDBOX_CGROUP_ROOT=/sys/fs/cgroup/bunvex -v /root/.bun/bin/bun:/usr/local/bin/bun:ro \
  -v "$R":/srv/repo -w /srv/repo sbstudy bun bench/process-sandbox/bench.ts $2; }
dock "" vm | tag docker
dock "$BWRAP_OPTS" bwrap | tag docker
dock "" confine | tag docker

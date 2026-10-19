#!/bin/bash
# STUDY-168: the escape probes only (run-tests.sh runs them too), in Docker.
R=${1:?repo dir}
D=$(dirname "$0")
BWRAP_OPTS="--security-opt seccomp=$D/seccomp-bwrap.json --security-opt apparmor=bunvex-sandbox --security-opt systempaths=unconfined --security-opt writable-cgroups=true"
run() {
  echo "== $1"
  docker run --rm --init $2 $3 -v /root/.bun/bin/bun:/usr/local/bin/bun:ro -v "$R":/srv/repo -w /srv/repo sbstudy \
    sh -c "$4" 2>&1 | grep -E '^\{'
}
run "escape probes" "$BWRAP_OPTS" "-e SANDBOX_STUDY=1 -e SANDBOX_CGROUP_ROOT=/sys/fs/cgroup/bunvex" \
  "bun bench/process-sandbox/escapes-report.ts vm bwrap confine"
for s in seccomp landlock "seccomp,landlock" uid fs env cgroup; do
  run "escape probes, confine, sabotage $s" "" "-e SANDBOX_STUDY=1 -e SANDBOX_SABOTAGE=$s" \
    "bun bench/process-sandbox/escapes-report.ts confine"
done

#!/bin/bash
# STUDY-168: the sandbox tests and escape probes inside Docker, on the VPS (as root, Docker 29).
#   bench/process-sandbox/docker/run-tests.sh <repo dir> > results/docker-tests.txt
# bwrap needs: the seccomp profile from make-seccomp.py, the AppArmor profile apparmor-bunvex-sandbox (loaded with
# apparmor_parser -r), systempaths=unconfined (a new /proc cannot be mounted over Docker's masked one) and
# writable-cgroups=true (the per-child cgroup). "confine" needs none of them.
R=${1:?repo dir}
D=$(dirname "$0")
BWRAP_OPTS="--security-opt seccomp=$D/seccomp-bwrap.json --security-opt apparmor=bunvex-sandbox --security-opt systempaths=unconfined --security-opt writable-cgroups=true"
run() { # label, docker options, env, command
  echo "== $1"
  docker run --rm --init $2 $3 -v /root/.bun/bin/bun:/usr/local/bin/bun:ro -v "$R":/srv/repo -w /srv/repo sbstudy \
    sh -c "$4" 2>&1 | grep -E '^\((pass|fail|skip)\)|^ *[0-9]+ (pass|fail)|^\{' 
}
T="bun test --timeout 60000 bench/process-sandbox"
run "bwrap, minimum options" "$BWRAP_OPTS" "-e SANDBOX_STUDY=1 -e SANDBOX_CGROUP_ROOT=/sys/fs/cgroup/bunvex" "$T"
run "bwrap, --privileged" "--privileged" "-e SANDBOX_STUDY=1 -e SANDBOX_CGROUP_ROOT=/sys/fs/cgroup/bunvex" "$T"
run "confine, default docker run" "" "-e SANDBOX_STUDY=1 -e SANDBOX_MODE=confine" "$T"
for s in seccomp landlock "seccomp,landlock" uid fs env cgroup timeout; do
  run "confine, sabotage $s" "" "-e SANDBOX_STUDY=1 -e SANDBOX_MODE=confine -e SANDBOX_SABOTAGE=$s" "$T"
done
"$D/run-probes.sh" "$R"

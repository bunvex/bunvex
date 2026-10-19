#!/bin/bash
# STUDY-168: which `docker run` options let bubblewrap start a full sandbox inside a container (VPS: Docker 29.1,
# Ubuntu 24.04 with kernel.apparmor_restrict_unprivileged_userns=1). Needs the image from ./Dockerfile (`sbstudy`),
# seccomp-bwrap.json (make-seccomp.py) and the AppArmor profile apparmor-bunvex-sandbox loaded.
#   bench/process-sandbox/docker/matrix.sh > results/docker-matrix.txt
D=$(cd "$(dirname "$0")" && pwd)
B="bwrap --unshare-all --uid 65534 --gid 65534 --cap-drop ALL --die-with-parent --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin --proc /proc --dev /dev /usr/bin/id"
NOPROC=${B/--proc \/proc /}
run() { local label="$1" cmd="$2"; shift 2; echo "$label | $(docker run --rm "$@" sbstudy sh -c "$cmd" 2>&1 | tr '\n' ' ')"; }
S="--security-opt seccomp=$D/seccomp-bwrap.json"
A="--security-opt apparmor=bunvex-sandbox"
run "default" "$B"
run "seccomp=unconfined" "$B" --security-opt seccomp=unconfined
run "apparmor=unconfined" "$B" --security-opt apparmor=unconfined
run "seccomp+apparmor unconfined" "$B" --security-opt seccomp=unconfined --security-opt apparmor=unconfined
run "cap SYS_ADMIN" "$B" --cap-add SYS_ADMIN
run "cap SYS_ADMIN + apparmor=unconfined" "$B" --cap-add SYS_ADMIN --security-opt apparmor=unconfined
run "privileged" "$B" --privileged
run "bwrap seccomp profile only" "$B" $S
run "bwrap seccomp + bunvex-sandbox apparmor" "$B" $S $A
run "  ... without /proc in the sandbox" "$NOPROC" $S $A
run "  ... + systempaths=unconfined" "$B" $S $A --security-opt systempaths=unconfined
run "  ... + systempaths=unconfined, --user 1000" "$B" $S $A --security-opt systempaths=unconfined --user 1000:1000
run "cgroup writable? default" "mkdir /sys/fs/cgroup/t && echo writable"
run "cgroup writable? writable-cgroups=true" "mkdir /sys/fs/cgroup/t && echo writable" --security-opt writable-cgroups=true
run "cgroup writable? cap SYS_ADMIN" "mkdir /sys/fs/cgroup/t && echo writable" --cap-add SYS_ADMIN

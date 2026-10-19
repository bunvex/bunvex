#!/bin/bash
# STUDY-168 §10.5: the sandbox with an unprivileged host on Ubuntu 24.04, keeping
# kernel.apparmor_restrict_unprivileged_userns=1. Run as root on the VPS; prints what each step gives.
#   - a service user `bunvex-study`;
#   - a copy of bwrap only that user's group may run, with an AppArmor profile allowing it user namespaces;
#   - the tests in a systemd unit with Delegate=yes (the unit's cgroup belongs to the user).
set -u
REPO=${1:?repo dir}
U=bunvex-study
SRV=/srv/bunvex-study
id $U >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$U --shell /usr/sbin/nologin $U
install -d -o root -g $U -m 0750 /opt/bunvex-study/bin
install -o root -g $U -m 0750 /usr/bin/bwrap /opt/bunvex-study/bin/bwrap
install -o root -g root -m 0755 /root/.bun/bin/bun /usr/local/bin/bun
rsync -a --delete --exclude results "$REPO"/ $SRV/ && chown -R $U:$U $SRV
cp "$REPO"/bench/process-sandbox/seccomp.bpf $SRV/bench/process-sandbox/ 2>/dev/null
echo "sysctl: $(sysctl -n kernel.apparmor_restrict_unprivileged_userns)"
TRY="--unshare-all --uid 65534 --gid 65534 --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev /usr/bin/id"

echo "== 1. no profile: the system bwrap, then the copy"
[ -f /etc/apparmor.d/bunvex-study-bwrap ] && apparmor_parser -R /etc/apparmor.d/bunvex-study-bwrap && rm /etc/apparmor.d/bunvex-study-bwrap
runuser -u $U -- /usr/bin/bwrap $TRY 2>&1 | head -2
runuser -u $U -- /opt/bunvex-study/bin/bwrap $TRY 2>&1 | head -2

echo "== 2. an AppArmor profile for the copy only (as Ubuntu ships for browsers): unconfined, plus userns"
cat > /etc/apparmor.d/bunvex-study-bwrap <<'P'
abi <abi/4.0>,
include <tunables/global>
profile bunvex-study-bwrap /opt/bunvex-study/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bunvex-study-bwrap>
}
P
apparmor_parser -r /etc/apparmor.d/bunvex-study-bwrap && echo loaded
runuser -u $U -- /opt/bunvex-study/bin/bwrap $TRY 2>&1 | head -2
runuser -u $U -- /usr/bin/bwrap $TRY 2>&1 | head -1
echo "another user (nobody) on the copy: $(runuser -u nobody -- /opt/bunvex-study/bin/bwrap $TRY 2>&1 | head -1)"

echo "== 3. the tests as $U, in a unit with Delegate=yes"
systemd-run --quiet --wait --pipe --collect -p User=$U -p Delegate=yes -p WorkingDirectory=$SRV \
  -E HOME=/home/$U -E SANDBOX_STUDY=1 -E SANDBOX_UNPRIVILEGED=1 -E SANDBOX_CGROUP_ROOT=auto \
  -E SANDBOX_BWRAP=/opt/bunvex-study/bin/bwrap \
  /usr/local/bin/bun test --timeout 60000 bench/process-sandbox 2>&1 | grep -E '^\((pass|fail|skip)\)|^ *[0-9]+ (pass|fail)|rror'

echo "== 4. the same without Delegate=yes"
systemd-run --quiet --wait --pipe --collect -p User=$U -p WorkingDirectory=$SRV \
  -E HOME=/home/$U -E SANDBOX_STUDY=1 -E SANDBOX_UNPRIVILEGED=1 -E SANDBOX_CGROUP_ROOT=auto \
  -E SANDBOX_BWRAP=/opt/bunvex-study/bin/bwrap \
  /usr/local/bin/bun test --timeout 60000 bench/process-sandbox -t "every escape" 2>&1 | grep -E '^\((pass|fail)\)|EACCES|rror' | head -3

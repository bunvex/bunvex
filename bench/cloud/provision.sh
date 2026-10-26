#!/usr/bin/env bash
# bench/cloud: prepares an Ubuntu 24.04 box (a fresh droplet or an existing test box) for the cloud bench.
# Run by cloud.ts over ssh as root, with the Bun version to install (the Mac's, so both sides match).
# Installs Bun, k6, Docker (Postgres runs in a container), and raises the open-file limit for many sockets.
set -euo pipefail
BUN_VERSION="$1"
export DEBIAN_FRONTEND=noninteractive

# A fresh droplet runs cloud-init and unattended upgrades at boot; apt waits for both.
cloud-init status --wait >/dev/null 2>&1 || true
apt-get -o DPkg::Lock::Timeout=300 update -q
apt-get -o DPkg::Lock::Timeout=300 install -yq unzip ca-certificates curl gnupg docker.io >/dev/null

if ! command -v k6 >/dev/null; then
  curl -fsSL https://dl.k6.io/key.gpg | gpg --dearmor --yes -o /usr/share/keyrings/k6-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
    >/etc/apt/sources.list.d/k6.list
  apt-get -o DPkg::Lock::Timeout=300 update -q
  apt-get -o DPkg::Lock::Timeout=300 install -yq k6 >/dev/null
fi

if [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun
fi

cat >/etc/security/limits.d/bench.conf <<'EOF'
root soft nofile 1048576
root hard nofile 1048576
EOF
sysctl -qw net.core.somaxconn=65535 net.ipv4.ip_local_port_range="1024 65535" net.ipv4.tcp_tw_reuse=1

echo "bun $(bun --version), $(k6 version | head -1), $(docker --version)"

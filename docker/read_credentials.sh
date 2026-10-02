#!/usr/bin/env bash
# The instance's name and secret (STUDY-40 L2), as Convex's read_credentials.sh: the environment's, else the
# ones kept in the volume, else a new secret and the default name; kept in the volume either way, so a restart
# (and generate_admin_key.sh) finds the same ones. Sourced by run_backend.sh and generate_admin_key.sh.
DATA_DIR=${DATA_DIR:-/bunvex/data}
CREDENTIALS_DIR=${CREDENTIALS_DIR:-"$DATA_DIR/credentials"}

set -e
mkdir -p "$CREDENTIALS_DIR"

export INSTANCE_SECRET=${INSTANCE_SECRET:-$(cat "$CREDENTIALS_DIR/instance_secret" 2>/dev/null || openssl rand -hex 32)}
echo "$INSTANCE_SECRET" > "$CREDENTIALS_DIR/instance_secret"
chmod 600 "$CREDENTIALS_DIR/instance_secret"

export INSTANCE_NAME=${INSTANCE_NAME:-$(cat "$CREDENTIALS_DIR/instance_name" 2>/dev/null || echo "bunvex-self-hosted")}
echo "$INSTANCE_NAME" > "$CREDENTIALS_DIR/instance_name"

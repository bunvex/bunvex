#!/bin/sh
# The container's entrypoint (STUDY-38), as Convex's run_backend.sh: `bunvex start` on the container's fixed
# ports, its data (and credentials) in the volume, the public origins from BUNVEX_CLOUD_ORIGIN /
# BUNVEX_SITE_ORIGIN. The database (POSTGRES_URL, MYSQL_URL, PERSISTENCE, …) and S3 (S3_STORAGE_*_BUCKET,
# AWS_*) are read by the server itself; SQLite in the volume otherwise.
set -e
DATA_DIR=${DATA_DIR:-/bunvex/data}
export TMPDIR=${TMPDIR:-"$DATA_DIR/tmp"}
mkdir -p "$TMPDIR"

if [ -z "$AWS_REGION" ] && { [ -n "$S3_STORAGE_FILES_BUCKET" ] || [ -n "$S3_STORAGE_MODULES_BUCKET" ]; }; then
  echo "Warning: an S3 bucket is set but AWS_REGION is not." >&2
fi

# --port and --site-proxy-port are the container's own; the origins are how the outside world reaches it
# (file URLs, BUNVEX_CLOUD_URL / BUNVEX_SITE_URL).
exec bun /bunvex/packages/bunvex/bin/bunvex.ts start \
  --data-dir "$DATA_DIR" \
  --port 3210 \
  --site-proxy-port 3211 \
  --cloud-origin "${BUNVEX_CLOUD_ORIGIN:-http://127.0.0.1:3210}" \
  --site-origin "${BUNVEX_SITE_ORIGIN:-http://127.0.0.1:3211}" \
  ${REDACT_LOGS_TO_CLIENT:+--redact-logs-to-client} \
  "$@"

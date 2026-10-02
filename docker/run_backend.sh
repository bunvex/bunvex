#!/usr/bin/env bash
# The container's entrypoint (STUDY-40 L2), as Convex's run_backend.sh: the credentials, the database and the
# storage from the environment, then bunvex-local-backend on the container's own ports.
export DATA_DIR=${DATA_DIR:-/bunvex/data}
export TMPDIR=${TMPDIR:-"$DATA_DIR/tmp"}
export STORAGE_DIR=${STORAGE_DIR:-"$DATA_DIR/storage"}
export SQLITE_DB=${SQLITE_DB:-"$DATA_DIR/db.sqlite3"}

set -e
mkdir -p "$TMPDIR" "$STORAGE_DIR"

source ./read_credentials.sh

# The database: POSTGRES_URL, else MYSQL_URL, else DATABASE_URL (deprecated), else PERSISTENCE with
# PERSISTENCE_URL (mongodb too), else SQLite in the volume. A URL names its database.
if [ -n "$POSTGRES_URL" ]; then
  DB_SPEC="$POSTGRES_URL"; DB_FLAGS=(--db postgres)
elif [ -n "$MYSQL_URL" ]; then
  DB_SPEC="$MYSQL_URL"; DB_FLAGS=(--db mysql)
elif [ -n "$DATABASE_URL" ]; then
  echo "Warning: DATABASE_URL is deprecated. Please use POSTGRES_URL for PostgreSQL or MYSQL_URL for MySQL connections instead."
  DB_SPEC="$DATABASE_URL"; DB_FLAGS=(--db postgres)
elif [ -n "$PERSISTENCE" ] && [ "$PERSISTENCE" != sqlite ]; then
  DB_SPEC="$PERSISTENCE_URL"; DB_FLAGS=(--db "$PERSISTENCE")
else
  DB_SPEC="$SQLITE_DB"; DB_FLAGS=()
fi

# Storage: S3 for each use case whose bucket is set (with AWS_REGION), else the volume (STUDY-38 K4).
if [ -n "$S3_STORAGE_FILES_BUCKET$S3_STORAGE_MODULES_BUCKET$S3_STORAGE_EXPORTS_BUCKET" ]; then
  [ -n "$AWS_REGION" ] || echo "Warning: an S3 bucket is set but AWS_REGION is not." >&2
  STORAGE_FLAGS=(--s3-storage)
else
  STORAGE_FLAGS=(--local-storage "$STORAGE_DIR")
fi

# --port and --site-proxy-port are the container's own; the origins are how the outside world reaches it
# (file URLs, BUNVEX_CLOUD_URL / BUNVEX_SITE_URL).
exec ./bunvex-local-backend "$@" \
  --instance-name "$INSTANCE_NAME" \
  --instance-secret "$INSTANCE_SECRET" \
  --port 3210 \
  --site-proxy-port 3211 \
  --cloud-origin "${BUNVEX_CLOUD_ORIGIN:-http://127.0.0.1:3210}" \
  --site-origin "${BUNVEX_SITE_ORIGIN:-http://127.0.0.1:3211}" \
  ${REDACT_LOGS_TO_CLIENT:+--redact-logs-to-client} \
  ${DO_NOT_REQUIRE_SSL:+--do-not-require-ssl} \
  ${DB_FLAGS[@]+"${DB_FLAGS[@]}"} \
  "${STORAGE_FLAGS[@]}" \
  "$DB_SPEC"

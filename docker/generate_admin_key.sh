#!/bin/sh
# An admin key for this deployment (STUDY-38), as Convex's generate_admin_key.sh:
#   docker compose exec backend ./generate_admin_key.sh
# The credentials are the ones `bunvex start` keeps in the volume. Extra flags (--read-only, --system) pass on.
set -e
exec bun /bunvex/packages/bunvex/bin/bunvex.ts admin-key --data-dir "${DATA_DIR:-/bunvex/data}" "$@"

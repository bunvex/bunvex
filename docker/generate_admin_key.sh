#!/usr/bin/env bash
# An admin key for this deployment (STUDY-40 L2), as Convex's generate_admin_key.sh:
#   docker compose exec backend ./generate_admin_key.sh
set -e
source ./read_credentials.sh
./bunvex-local-backend keygen admin-key --instance-name "$INSTANCE_NAME" --instance-secret "$INSTANCE_SECRET"

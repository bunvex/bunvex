#!/usr/bin/env bash
# An admin key for this deployment (STUDY-40 L2), as Convex's generate_admin_key.sh:
#   docker compose exec backend ./generate_admin_key.sh
set -e
source ./read_credentials.sh
# The secret in INSTANCE_SECRET (exported by read_credentials.sh), off the command line (DV-525).
./bunvex-local-backend keygen admin-key --instance-name "$INSTANCE_NAME"

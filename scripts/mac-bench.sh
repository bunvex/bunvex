#!/usr/bin/env bash
# bunvex on the Mac: the HTTP suite (bench/load) for each storage, one at a time.
# Postgres and MySQL come from scripts/mac-stores.sh start. MongoDB is off the default list.
#   scripts/mac-bench.sh
# The 4 MiB/s write cap stays off unless MAX_BYTES_WRITTEN_PER_SECOND is set. Fan-out is a later harness.
set -uo pipefail
cd "$(dirname "$0")/.."
export PG_URL=postgres://$USER@127.0.0.1:5434/bunvex
export MYSQL_URL=mysql://root@127.0.0.1:3307/bunvex
export DO_NOT_REQUIRE_SSL=1
exec bun bench/load/run.ts

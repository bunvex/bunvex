#!/usr/bin/env bash
# STUDY-190 on two droplets from bench/cloud/cloud.ts (`up`), run on the server box from the repository's root:
#   bash bench/offthread/cloud-suite.sh <load box private ip> <server box private ip>
# The server box must reach the load box over ssh as root (a key of its own, authorized there). Seeds a SQLite store
# and a Postgres database once (Postgres 17 in Docker on this box), then runs bench/offthread/profile.ts for the
# baseline, its profiles, and each prototype, with k6 on the load box. Results: /root/offthread/<step>/summary.md.
# Env: VUS (64), DURATION (20s), REPEATS (2), STEPS (all of them, comma-separated).
set -euo pipefail
LOAD=$1
SELF=$2
OUT=/root/offthread
PG=postgres://postgres:bench@127.0.0.1:5432
export VUS=${VUS:-64} DURATION=${DURATION:-20s}
REPEATS=${REPEATS:-2}
mkdir -p $OUT

if ! docker ps -q -f name=^offthread-pg$ | grep -q .; then
  docker rm -f offthread-pg >/dev/null 2>&1 || true
  docker run -d --name offthread-pg --network host -e POSTGRES_PASSWORD=bench postgres:17 \
    -c listen_addresses=127.0.0.1 -c max_connections=1000 >/dev/null
  for _ in $(seq 100); do docker exec offthread-pg psql -U postgres -qc 'select 1' >/dev/null 2>&1 && break; sleep 0.3; done
fi
seed() { # persistence, env…
  local p=$1
  shift
  env "$@" PERSISTENCE=$p PORT=3711 BENCH_HOSTNAME=127.0.0.1 DO_NOT_REQUIRE_SSL=1 bun bench/server.ts >$OUT/seed-$p.log 2>&1 &
  local pid=$!
  for _ in $(seq 100); do curl -sf -o /dev/null http://127.0.0.1:3711/version && break; sleep 0.2; done
  BENCH_URL=http://127.0.0.1:3711 bun bench/seed.ts
  kill -INT $pid
  wait $pid || true
}
if [ ! -f $OUT/sqlite-seed/bunvex.sqlite ]; then
  rm -rf $OUT/sqlite-seed
  seed sqlite DATA=$OUT/sqlite-seed
fi
if ! docker exec offthread-pg psql -U postgres -lqt | cut -d'|' -f1 | grep -qw seed190; then
  docker exec offthread-pg psql -U postgres -qc 'create database seed190'
  seed postgres PERSISTENCE_URL=$PG/seed190 DATA=$OUT/pg-files
fi

COMMON=(SEED_SQLITE=$OUT/sqlite-seed PG_URL=$PG PG_TEMPLATE=seed190 LOAD_SSH=root@$LOAD URL_HOST=$SELF)
step() { # name, env…
  local name=$1
  shift
  if [ -n "${STEPS:-}" ] && [[ ",$STEPS," != *",$name,"* ]]; then return; fi
  echo "== $name"
  env "${COMMON[@]}" OUT=$OUT/$name "$@" bun bench/offthread/profile.ts >$OUT/$name.log 2>&1 || echo "$name failed"
}
step base PROFILE=0 REPEATS=$REPEATS
step profiles PROFILE=1 REPEATS=1
step writer PROFILE=0 REPEATS=$REPEATS SERVER=bench/offthread/server.ts OFFTHREAD_WRITER=1 PERSISTENCES=sqlite \
  SCENARIOS=insert,increment1000
step writer-readers2 PROFILE=0 REPEATS=$REPEATS SERVER=bench/offthread/server.ts OFFTHREAD_WRITER=1 OFFTHREAD_READERS=2 \
  PERSISTENCES=sqlite SCENARIOS=uncached,increment1000
for f in 1 2 3; do
  step front$f PROFILE=0 REPEATS=$REPEATS SERVER=bench/offthread/server.ts OFFTHREAD_FRONT=$f PERSISTENCES=sqlite \
    SCENARIOS=cached,uncached
done
step front2-postgres PROFILE=0 REPEATS=$REPEATS SERVER=bench/offthread/server.ts OFFTHREAD_FRONT=2 PERSISTENCES=postgres \
  SCENARIOS=cached
step front2-writer PROFILE=0 REPEATS=$REPEATS SERVER=bench/offthread/server.ts OFFTHREAD_FRONT=2 OFFTHREAD_WRITER=1 \
  PERSISTENCES=sqlite SCENARIOS=insert,increment1000
step front2-profile PROFILE=1 REPEATS=1 SERVER=bench/offthread/server.ts OFFTHREAD_FRONT=2 PERSISTENCES=sqlite \
  SCENARIOS=cached
if [ -z "${STEPS:-}" ] || [[ ",$STEPS," == *",micro,"* ]]; then
  bun bench/offthread/messaging.ts >$OUT/messaging.md 2>&1
  bun bench/offthread/values-split.ts >$OUT/values-split.md 2>&1
fi
echo done

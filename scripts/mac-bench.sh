#!/usr/bin/env bash
# bunvex on the Mac: the convex-bench HTTP suite + fan-out, for every storage, one at a time.
#   scripts/mac-bench.sh   (needs scripts/mac-stores.sh start)
set -uo pipefail
cd "$(dirname "$0")/.."
# The convex-bench harness checkout (CONVEX_BENCH); defaults to a sibling directory.
CB="${CONVEX_BENCH:-$(cd "$(dirname "$0")/../.." && pwd)/convex-bench}"
PGB=/opt/homebrew/opt/postgresql@17/bin; MYB=/opt/homebrew/opt/mysql@8.4/bin; MOB="$PWD/.data/mongo-bin/bin"
export PG_URL=postgres://$USER@127.0.0.1:5434/bunvex MYSQL_URL=mysql://root@127.0.0.1:3307/bunvex MONGO_URL=mongodb://127.0.0.1:27018/bunvex
# The local stores have no TLS (Postgres) or unverifiable certificates (MySQL): TLS is required by default.
export DO_NOT_REQUIRE_SSL=1
url_of() { case $1 in postgres) echo "$PG_URL" ;; mysql) echo "$MYSQL_URL" ;; mongodb) echo "$MONGO_URL" ;; esac; }
stop() { pkill -f "bun bench/server.ts"; sleep 1; }
fresh() {
  rm -rf .data/bunvex.sqlite* .data/bunvex.log
  "$PGB/psql" -h 127.0.0.1 -p 5434 -d postgres -qc "drop database if exists bunvex" -c "create database bunvex" 2>/dev/null
  "$MYB/mysql" -h127.0.0.1 -P3307 -uroot -e "drop database if exists bunvex; create database bunvex"
  bun -e 'const {MongoClient}=require("mongodb");const c=new MongoClient(process.env.MONGO_URL);await c.connect();await c.db().dropDatabase();await c.close()'
}
for st in ${STORES:-memory sqlite postgres mysql mongodb}; do
  if [ -z "${SKIP_HTTP:-}" ]; then
  stop; fresh
  PERSISTENCE=$st PERSISTENCE_URL=$(url_of $st) DATA=.data PORT=3210 nohup bun bench/server.ts > .data/mac-server-$st.log 2>&1 < /dev/null &
  for i in $(seq 1 60); do curl -fs 127.0.0.1:3210/version >/dev/null && break; sleep 0.5; done
  BENCH_URL=http://127.0.0.1:3210 bun bench/seed.ts
  PID=$(pgrep -f "bun bench/server.ts" | head -1)
  (cd $CB && MONITOR_PID=$PID BENCH_URL=http://127.0.0.1:3210 SKIP_SEED=1 FANOUT_LIST= DURATION=${DURATION:-10s} DB=$st PROFILE=bunvex LABEL=mac-bunvex-$st scripts/run-suite.sh < /dev/null 2>/dev/null | grep -E "vus=")
  fi
  # The insert scenario once more with Convex's 4 MiB/s write throughput limit (bench/server.ts lifts it).
  if [ -z "${SKIP_HTTP:-}" ] && [ -z "${SKIP_LIMIT:-}" ]; then
  stop; fresh
  MAX_BYTES_WRITTEN_PER_SECOND=4194304 PERSISTENCE=$st PERSISTENCE_URL=$(url_of $st) DATA=.data PORT=3210 nohup bun bench/server.ts > .data/mac-server-limit-$st.log 2>&1 < /dev/null &
  for i in $(seq 1 60); do curl -fs 127.0.0.1:3210/version >/dev/null && break; sleep 0.5; done
  BENCH_URL=http://127.0.0.1:3210 bun bench/seed.ts
  PID=$(pgrep -f "bun bench/server.ts" | head -1)
  (cd $CB && MONITOR_PID=$PID BENCH_URL=http://127.0.0.1:3210 SKIP_SEED=1 FANOUT_LIST= SCENARIOS=insert DURATION=${DURATION:-10s} DB=$st PROFILE=bunvex LABEL=mac-bunvex-limit-$st scripts/run-suite.sh < /dev/null 2>/dev/null | grep -E "vus=")
  fi
  stop; fresh
  PERSISTENCE=$st PERSISTENCE_URL=$(url_of $st) DATA=.data PORT=3210 nohup bun bench/server.ts > .data/mac-server-fan-$st.log 2>&1 < /dev/null &
  for i in $(seq 1 60); do curl -fs 127.0.0.1:3210/version >/dev/null && break; sleep 0.5; done
  PID=$(pgrep -f "bun bench/server.ts" | head -1)
  (cd $CB && FLAVOR=bunvex MONITOR_PID=$PID BENCH_URL=http://127.0.0.1:3210 SKIP_SEED=1 SCENARIOS= FANOUT_LIST="100 1000 5000 10000" DB=$st PROFILE=bunvex LABEL=mac-bunvex-fanout-$st scripts/run-suite.sh < /dev/null 2>&1 | grep -E "entregas|latência de entrega|fanout:")
done
stop
echo MAC-BENCH-DONE

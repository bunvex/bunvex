#!/usr/bin/env bash
# Disposable, NATIVE (no Docker VM) Postgres 17, MySQL 8.4 and MongoDB 8.0 for bunvex on macOS.
# Data lives under .data/stores; nothing is installed as a service.
#   scripts/mac-stores.sh start|stop|urls
# Requires: brew install postgresql@17 mysql@8.4; MongoDB binaries in .data/mongo-bin (official tarball).
set -uo pipefail
cd "$(dirname "$0")/.."
D="$PWD/.data/stores"; mkdir -p "$D"
PG=/opt/homebrew/opt/postgresql@17/bin
MY=/opt/homebrew/opt/mysql@8.4/bin
MO="$PWD/.data/mongo-bin/bin"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

urls() {
  echo "PG_URL=postgres://$USER@127.0.0.1:5434/bunvex"
  echo "MYSQL_URL=mysql://root@127.0.0.1:3307/bunvex"
  echo "MONGO_URL=mongodb://127.0.0.1:27018/bunvex"
  echo "DO_NOT_REQUIRE_SSL=1   # these stores have no verifiable TLS; bunvex requires it by default"
}

start() {
  # Postgres
  if [ ! -d "$D/pg" ]; then "$PG/initdb" -D "$D/pg" -U "$USER" --auth=trust >/dev/null; fi
  "$PG/pg_ctl" -D "$D/pg" -o "-p 5434 -c listen_addresses=127.0.0.1 -c max_connections=200 -c shared_buffers=1GB" -l "$D/pg.log" -w start >/dev/null
  "$PG/psql" -h 127.0.0.1 -p 5434 -d postgres -tAc "select 1 from pg_database where datname='bunvex'" | grep -q 1 \
    || "$PG/psql" -h 127.0.0.1 -p 5434 -d postgres -qc "create database bunvex"
  echo "postgres ok (5434)"

  # MySQL: durable defaults (innodb_flush_log_at_trx_commit=1, sync_binlog=1)
  if [ ! -d "$D/mysql" ]; then "$MY/mysqld" --initialize-insecure --datadir="$D/mysql" --user="$USER" 2>/dev/null; fi
  "$MY/mysqld" --datadir="$D/mysql" --port=3307 --bind-address=127.0.0.1 --socket="$D/mysql.sock" \
    --mysqlx=OFF --innodb-buffer-pool-size=1G --max-connections=300 --log-error="$D/mysql.err" --pid-file="$D/mysql.pid" &>/dev/null &
  for i in $(seq 1 60); do "$MY/mysql" -h127.0.0.1 -P3307 -uroot -e "select 1" &>/dev/null && break; sleep 0.5; done
  "$MY/mysql" -h127.0.0.1 -P3307 -uroot -e "create database if not exists bunvex"
  echo "mysql ok (3307)"

  # MongoDB (journaled by default)
  mkdir -p "$D/mongo"
  "$MO/mongod" --dbpath "$D/mongo" --port 27018 --bind_ip 127.0.0.1 --wiredTigerCacheSizeGB 1 \
    --logpath "$D/mongo.log" --pidfilepath "$D/mongo.pid" --fork >/dev/null
  echo "mongodb ok (27018)"
}

stop() {
  "$PG/pg_ctl" -D "$D/pg" -m fast stop >/dev/null 2>&1 && echo "postgres stopped"
  [ -f "$D/mysql.pid" ] && kill "$(cat "$D/mysql.pid")" 2>/dev/null && echo "mysql stopped"
  [ -f "$D/mongo.pid" ] && kill "$(cat "$D/mongo.pid")" 2>/dev/null && echo "mongodb stopped"
  true
}

case "${1:-}" in start) start ;; stop) stop ;; urls) urls ;; *) sed -n 2,6p "$0"; exit 1 ;; esac

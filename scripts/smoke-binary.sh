#!/usr/bin/env bash
# bunvex-local-backend end to end (STUDY-39, STUDY-40), step by step as Convex's "running the binary directly"
# guide: a secret, an admin key from `keygen admin-key`, the backend in an empty directory, the CLI deploying
# and running against it, a restart on the same data. SMOKE_POSTGRES_URL=postgres://… runs it on Postgres.
#   scripts/smoke-binary.sh dist/bin/x86_64-unknown-linux-gnu/bunvex-local-backend
set -euo pipefail
BIN=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-16210}
WORK=$(mktemp -d)
PID=""
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "smoke-binary: $*" >&2; cat "$WORK/backend.log" >&2 2>/dev/null || true; exit 1; }

NAME=bunvex-self-hosted
SECRET=$(openssl rand -hex 32)
DB=()
want=sqlite
if [ -n "${SMOKE_POSTGRES_URL:-}" ]; then DB=(--db postgres --do-not-require-ssl "$SMOKE_POSTGRES_URL"); want=postgres; fi

[[ "$("$BIN" --version)" == "bunvex-local-backend "* ]] || fail "--version"
NOSECRET=$("$BIN" --port "$PORT" 2>&1 || true)
[[ "$NOSECRET" == *"--instance-secret is required"* ]] || fail "a missing secret is not refused"
KEY=$("$BIN" keygen admin-key --instance-name "$NAME" --instance-secret "$SECRET") || fail "keygen failed"

start() {
  (cd "$WORK" && exec "$BIN" --instance-name "$NAME" --instance-secret "$SECRET" --port "$PORT" --site-proxy-port $((PORT + 1)) ${DB[@]+"${DB[@]}"} >"$WORK/backend.log" 2>&1) &
  PID=$!
  for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/instance_name" >/dev/null && return; sleep 0.2; done
  fail "the backend did not come up"
}
start
[[ "$(cat "$WORK/backend.log")" == *"instance $NAME, $want"* ]] || fail "not on $want"
[ "$want" = postgres ] || [ -f "$WORK/bunvex_local_backend.sqlite3" ] || fail "no SQLite file in the working directory"

mkdir -p "$WORK/app/bunvex"
cat >"$WORK/app/bunvex/items.ts" <<'TS'
import { mutation, query } from "bunvex/server";
export const add = mutation(async ({ db }, { n }: { n: number }) => {
  await db.insert("items", { n });
});
export const all = query(async ({ db }) => (await db.query("items").collect()).map((d) => d.n));
TS
cli() { (cd "$WORK/app" && BUNVEX_SELF_HOSTED_URL="http://127.0.0.1:$PORT" BUNVEX_SELF_HOSTED_ADMIN_KEY="$KEY" bun "$ROOT/packages/bunvex/bin/bunvex.ts" "$@"); }
cli deploy --typecheck=disable >/dev/null 2>&1 || fail "deploy failed"
cli run items:add '{ n: 42 }' >/dev/null 2>&1 || fail "run failed"
[ "$(cli run items:all 2>/dev/null | tr -d ' \n')" = "[42]" ] || fail "unexpected data"
[ "$want" = postgres ] || [ -d "$WORK/bunvex_local_storage/modules" ] || fail "no pushed code in bunvex_local_storage"

kill "$PID"; wait "$PID" 2>/dev/null || true; PID=""
start
[ "$(cli run items:all 2>/dev/null | tr -d ' \n')" = "[42]" ] || fail "data or key lost across a restart"
echo "smoke-binary: ok ($want)"

#!/usr/bin/env bash
# The standalone executable end to end (STUDY-39), as Convex's "running the binary directly" guide: start it
# in an empty directory, get an admin key, deploy and run an app with the same executable, restart it on the
# same data. SMOKE_POSTGRES_URL=postgres://… runs it on Postgres (DO_NOT_REQUIRE_SSL is set for a local one).
#   scripts/smoke-binary.sh dist/bin/x86_64-unknown-linux-gnu/bunvex
set -euo pipefail
BIN=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
PORT=${PORT:-16210}
WORK=$(mktemp -d)
PID=""
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "smoke-binary: $*" >&2; cat "$WORK/start.log" >&2 2>/dev/null || true; exit 1; }
if [ -n "${SMOKE_POSTGRES_URL:-}" ]; then export POSTGRES_URL="$SMOKE_POSTGRES_URL" DO_NOT_REQUIRE_SSL=1; want=postgres; else want=sqlite; fi

start() {
  (cd "$WORK" && exec "$BIN" start --port "$PORT" >"$WORK/start.log" 2>&1) &
  PID=$!
  for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/version" >/dev/null && return; sleep 0.2; done
  fail "the server did not come up"
}

"$BIN" --version | grep -q '^bunvex ' || fail "--version"
start
grep -q "bunvex: instance bunvex-self-hosted, $want in" "$WORK/start.log" || fail "not on $want"
KEY=$(cd "$WORK" && "$BIN" admin-key 2>/dev/null) || fail "admin-key failed"
mkdir -p "$WORK/app/bunvex"
cat >"$WORK/app/bunvex/items.ts" <<'TS'
import { mutation, query } from "bunvex/server";
export const add = mutation(async ({ db }, { n }: { n: number }) => {
  await db.insert("items", { n });
});
export const all = query(async ({ db }) => (await db.query("items").collect()).map((d) => d.n));
TS
cli() { (cd "$WORK/app" && BUNVEX_SELF_HOSTED_URL="http://127.0.0.1:$PORT" BUNVEX_SELF_HOSTED_ADMIN_KEY="$KEY" "$BIN" "$@"); }
cli deploy >/dev/null 2>&1 || fail "deploy failed"
cli run items:add '{ n: 42 }' >/dev/null 2>&1 || fail "run failed"
[ "$(cli run items:all 2>/dev/null | tr -d ' \n')" = "[42]" ] || fail "unexpected data"
# The generated code (codegen runs in deploy) is there.
[ -f "$WORK/app/bunvex/_generated/api.d.ts" ] || fail "no _generated/"

kill "$PID"; wait "$PID" 2>/dev/null || true; PID=""
start
[ "$(cli run items:all 2>/dev/null | tr -d ' \n')" = "[42]" ] || fail "data or key lost across a restart"
echo "smoke-binary: ok ($want)"

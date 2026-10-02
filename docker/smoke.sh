#!/usr/bin/env bash
# The Docker image end to end (STUDY-38), the flow Convex's self-hosted README documents: compose up, an admin
# key from generate_admin_key.sh, `bunvex deploy` and `bunvex run` from the host, then a restart that keeps the
# data and the key. Run from anywhere: docker/smoke.sh (PORT / SITE_PROXY_PORT pick the host ports;
# SMOKE_POSTGRES=1 runs it on Postgres).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROJECT="bunvex-smoke-$$"
export PORT=${PORT:-13210} SITE_PROXY_PORT=${SITE_PROXY_PORT:-13211}
APP=""
FILES=(-f "$ROOT/docker/docker-compose.yml")
# SMOKE_POSTGRES=1: on Postgres instead of SQLite.
[ -n "${SMOKE_POSTGRES:-}" ] && FILES+=(-f "$ROOT/docker/smoke-postgres.yml")
compose() { docker compose -p "$PROJECT" "${FILES[@]}" "$@"; }
cleanup() {
  compose down -v >/dev/null 2>&1 || true
  [ -n "$APP" ] && rm -rf "$APP"
}
trap cleanup EXIT
fail() { echo "smoke: $*" >&2; compose logs backend >&2 || true; exit 1; }

compose up -d --build --wait >/dev/null || fail "the deployment did not come up healthy"
KEY=$(compose exec -T backend ./generate_admin_key.sh 2>/dev/null) || fail "generate_admin_key.sh failed"
SECRET=$(compose exec -T backend cat /bunvex/data/credentials/instance_secret)
[[ "$KEY" == bunvex-self-hosted\|* ]] || fail "unexpected admin key: $KEY"
want=sqlite
[ -n "${SMOKE_POSTGRES:-}" ] && want=postgres
LOGS=$(compose logs backend)
[[ "$LOGS" == *"instance bunvex-self-hosted, $want"* ]] || fail "not on $want"

APP=$(mktemp -d)
mkdir "$APP/bunvex"
cat >"$APP/bunvex/items.ts" <<'TS'
import { mutation, query } from "bunvex/server";
export const add = mutation(async ({ db }, { n }: { n: number }) => {
  await db.insert("items", { n });
});
export const all = query(async ({ db }) => (await db.query("items").collect()).map((d) => d.n));
export const site = query(async () => process.env.BUNVEX_SITE_URL ?? null);
TS
cli() { (cd "$APP" && BUNVEX_SELF_HOSTED_URL="http://127.0.0.1:$PORT" BUNVEX_SELF_HOSTED_ADMIN_KEY="$KEY" bun "$ROOT/packages/bunvex/bin/bunvex.ts" "$@"); }
cli deploy --typecheck=disable >/dev/null 2>&1 || fail "deploy failed"
cli run items:add '{ n: 42 }' >/dev/null 2>&1 || fail "run failed"
[ "$(cli run items:all 2>/dev/null | tr -d ' \n')" = "[42]" ] || fail "unexpected data"
[ "$(cli run items:site 2>/dev/null)" = "\"http://127.0.0.1:$SITE_PROXY_PORT\"" ] || fail "unexpected site origin"

# A restart keeps the data, the code and the credentials: the same key still works (a key is issued anew each
# time, with its own time and nonce, so the secret is what stays the same).
compose restart backend >/dev/null || fail "restart failed"
healthy=""
for _ in $(seq 1 60); do
  id=$(compose ps -q backend)
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)" = healthy ] && healthy=1 && break
  sleep 1
done
[ -n "$healthy" ] || fail "not healthy after the restart"
[ "$(cli run items:all 2>/dev/null | tr -d ' \n')" = "[42]" ] || fail "data lost across a restart"
[ "$(compose exec -T backend cat /bunvex/data/credentials/instance_secret)" = "$SECRET" ] || fail "credentials changed across a restart"
echo "smoke: ok"

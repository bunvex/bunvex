#!/usr/bin/env bash
# The dashboard image end to end (STUDY-149 PR 7), the flow of Convex's self-hosted README: compose up brings the
# backend and the dashboard (its own image, on 6791) up; the dashboard's page comes with the backend's URL filled
# in; an admin key from generate_admin_key.sh signs in, in Chromium, and the Data screen shows what a function
# wrote. Run from anywhere: docker/smoke-dashboard.sh (PORT / SITE_PROXY_PORT / DASHBOARD_PORT pick the host ports;
# E2E_BROWSER=chromium uses Playwright's Chromium instead of the system Chrome).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROJECT="bunvex-smoke-dashboard-$$"
export PORT=${PORT:-13220} SITE_PROXY_PORT=${SITE_PROXY_PORT:-13221} DASHBOARD_PORT=${DASHBOARD_PORT:-16791}
APP=""
compose() { docker compose -p "$PROJECT" -f "$ROOT/docker/docker-compose.yml" "$@"; }
cleanup() {
  compose down -v >/dev/null 2>&1 || true
  [ -n "$APP" ] && rm -rf "$APP"
}
trap cleanup EXIT
fail() { echo "smoke-dashboard: $*" >&2; compose logs >&2 || true; exit 1; }

compose up -d --build --wait backend dashboard >/dev/null || fail "the services did not come up"
DASHBOARD="http://127.0.0.1:$DASHBOARD_PORT"
BACKEND="http://127.0.0.1:$PORT"
for _ in $(seq 1 50); do curl -sf "$DASHBOARD/" >/dev/null && break; sleep 0.2; done
PAGE=$(curl -sf "$DASHBOARD/") || fail "the dashboard does not answer"
[[ "$PAGE" == *'<div id="root">'* ]] || fail "not the dashboard's page"
[[ "$PAGE" == *"<meta name=\"bunvex-deployment-url\" content=\"$BACKEND\">"* ]] || fail "the backend's URL is not filled in"
# Convex's image headers on every answer (next.config.js headers()): framing same-origin only, as built here
headers_ok() {
  local h
  h=$(curl -s -o /dev/null -D - "$@" | tr -d '\r' | tr 'A-Z' 'a-z')
  for want in "x-frame-options: sameorigin" "content-security-policy: frame-ancestors 'self'" \
    "strict-transport-security: max-age=63072000; includesubdomains; preload" "referrer-policy: origin-when-cross-origin" \
    "x-xss-protection: 1; mode=block" "x-dns-prefetch-control: on"; do
    grep -qxF "$want" <<<"$h" || return 1
  done
}
headers_ok "$DASHBOARD/" || fail "the page lacks Convex's frame and security headers"
headers_ok "$DASHBOARD/assets/missing.js" || fail "a 404 lacks Convex's frame and security headers"
# a page of the app opened directly is the app; a missing asset is not
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'accept: text/html' "$DASHBOARD/database/items")" = 200 ] || fail "an app page is not served"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$DASHBOARD/assets/missing.js")" = 404 ] || fail "a missing asset is not a 404"
# the image hands out no credentials (the sign-in page is shown, as Convex's image)
[ "$(curl -s -o /dev/null -w '%{http_code}' "$DASHBOARD/api/current_deployment")" = 404 ] || fail "/api/current_deployment answers"

KEY=$(compose exec -T backend ./generate_admin_key.sh 2>/dev/null) || fail "generate_admin_key.sh failed"
APP=$(mktemp -d)
mkdir "$APP/bunvex"
cat >"$APP/bunvex/items.ts" <<'TS'
import { mutation } from "@bunvex/server";
export const add = mutation(async ({ db }, { n }: { n: number }) => {
  await db.insert("items", { n });
});
TS
cli() { (cd "$APP" && BUNVEX_SELF_HOSTED_URL="$BACKEND" BUNVEX_SELF_HOSTED_ADMIN_KEY="$KEY" bun "$ROOT/packages/cli/bin/bunvex.ts" "$@"); }
cli deploy --typecheck=disable >/dev/null 2>&1 || fail "deploy failed"
cli run items:add '{ n: 42 }' >/dev/null 2>&1 || fail "run failed"
bun "$ROOT/apps/dashboard/e2e/sign-in-smoke.ts" "$DASHBOARD" "$BACKEND" "$KEY" bunvex-self-hosted || fail "the sign-in failed"
echo "smoke-dashboard: ok"

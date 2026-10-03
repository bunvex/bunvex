#!/usr/bin/env bash
# The npm packages as an app gets them (STUDY-40 L7): pack them (scripts/publish-npm.ts --dry-run), install
# the tarballs in a new app outside the repository (with typescript and @types/bun, as `bun init` sets up),
# then `bunx bunvex codegen --init` with the typecheck on, `bunx bunvex dev --once` (a local deployment: the
# executable from BUNVEX_LOCAL_BACKEND_BINARY, or the latest release), and `bunx bunvex run`.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP=$(mktemp -d)
trap 'rm -rf "$APP"' EXIT
fail() { echo "smoke-npm: $*" >&2; exit 1; }

bun "$ROOT/scripts/publish-npm.ts" --dry-run >/dev/null
VERSION=$(bun -e "console.log(require('$ROOT/packages/server/package.json').version)")
bun -e "
const names = ['values','search','protocol','core','auth','file-storage','persistence','server','client','react','react-clerk','react-auth0','react-query','nextjs','cli'];
const f = (n) => 'file:$ROOT/dist/npm/bunvex-' + n + '-$VERSION.tgz';
await Bun.write('$APP/package.json', JSON.stringify({
  name: 'smoke-app', private: true, type: 'module',
  dependencies: { '@bunvex/server': f('server'), '@bunvex/values': f('values') },
  devDependencies: { '@bunvex/cli': f('cli'), typescript: '^5.9.0', '@types/bun': '^1.2.0' },
  overrides: Object.fromEntries(names.map((n) => ['@bunvex/' + n, f(n)])),
}, null, 2));
"
cd "$APP"
bun install >/dev/null 2>&1 || fail "bun install failed"
mkdir bunvex
cat > bunvex/schema.ts <<'TS'
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";
export default defineSchema({ messages: defineTable({ body: v.string() }) });
TS
cat > bunvex/messages.ts <<'TS'
import { v } from "@bunvex/values";
import { mutation, query } from "./_generated/server";
export const send = mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    await ctx.db.insert("messages", { body });
  },
});
export const list = query({
  args: {},
  handler: async (ctx): Promise<string[]> => (await ctx.db.query("messages").collect()).map((m) => m.body),
});
TS
export HOME="$APP/home"
bunx bunvex codegen --init --typecheck enable >"$APP/codegen.log" 2>&1 || { cat "$APP/codegen.log" >&2; fail "codegen or its typecheck failed"; }
grep -q 'from "@bunvex/server"' bunvex/_generated/server.d.ts || fail "_generated/ does not import @bunvex/server"
cat > bunvex/bad.ts <<'TS'
import { query } from "./_generated/server";
export const bad = query({ args: {}, handler: async (ctx) => ctx.db.query("nope").collect() });
TS
if bunx bunvex codegen >/dev/null 2>&1; then fail "a type error was not caught"; fi
rm bunvex/bad.ts
bunx bunvex dev --once >"$APP/dev.log" 2>&1 || { cat "$APP/dev.log" >&2; fail "dev --once failed"; }
bunx bunvex run messages:send '{ body: "oi" }' >/dev/null 2>&1 || fail "run failed"
[ "$(bunx bunvex run messages:list 2>/dev/null | tr -d ' \n')" = '["oi"]' ] || fail "unexpected data"
echo "smoke-npm: ok ($VERSION)"

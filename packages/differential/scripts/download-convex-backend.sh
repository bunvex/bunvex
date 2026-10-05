#!/usr/bin/env bash
# Fetch Convex's prebuilt local backend, the oracle of the differential tests (STUDY-103 D2), into
# packages/differential/.cache. Pinned so runs are reproducible; CONVEX_RELEASE overrides the tag.
# The binary is run, never vendored, and always with --disable-beacon (harness/backends.ts).
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${CONVEX_RELEASE:-precompiled-2026-09-26-27ef234}"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=aarch64-apple-darwin ;;
  Darwin-x86_64) TARGET=x86_64-apple-darwin ;;
  Linux-x86_64) TARGET=x86_64-unknown-linux-gnu ;;
  Linux-aarch64) TARGET=aarch64-unknown-linux-gnu ;;
  *) echo "no prebuilt backend for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
mkdir -p .cache
if [ -x .cache/convex-local-backend ] && [ "$(cat .cache/RELEASE 2>/dev/null)" = "$TAG" ]; then
  echo "already at $TAG"; exit 0
fi
ZIP=.cache/backend.zip
curl -fL --retry 3 -o "$ZIP" \
  "https://github.com/get-convex/convex-backend/releases/download/$TAG/convex-local-backend-$TARGET.zip"
unzip -o -q "$ZIP" -d .cache
rm "$ZIP"
chmod +x .cache/convex-local-backend
echo "$TAG" > .cache/RELEASE
echo "fetched $TAG ($TARGET)"

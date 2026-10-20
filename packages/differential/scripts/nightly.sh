#!/usr/bin/env bash
# The nightly differential run (STUDY-122 phase 4, D2): the fixed programs, then generated programs in batches
# of DIFF_RUNS, each batch from a fresh seed, until MINUTES have passed or a batch finds a difference. Each seed
# is printed, so any batch replays with DIFF_SEED. On a difference, summary.md says how to reproduce it and
# .cache/failures/last.json holds the shrunk program and its differences.
# Needs Convex's backend: scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN.
set -uo pipefail
cd "$(dirname "$0")/.."
MINUTES="${MINUTES:-20}"
export DIFF_RUNS="${DIFF_RUNS:-200}"
SUMMARY="${SUMMARY:-summary.md}"
rm -f .cache/failures/last.json "$SUMMARY"

fail() {
  {
    echo "$1"
    echo
    echo "Reproduce: \`cd packages/differential && $2\`"
    if [ -f .cache/failures/last.json ]; then
      echo
      echo "The shrunk program and its differences (\`.cache/failures/last.json\`, also the run's artifact):"
      echo
      echo '```json'
      head -c 60000 .cache/failures/last.json
      echo '```'
    fi
  } > "$SUMMARY"
  cat "$SUMMARY"
  exit 1
}

if ! bun test test/fixed.test.ts; then
  fail "A fixed program differs." "bun test test/fixed.test.ts"
fi

# A store with components, as Convex writes it, opened by bunvex and back (STUDY-152 steps 1-2).
if ! bun test test/component-store.test.ts; then
  fail "A store with components, as Convex writes it, does not open in bunvex and back." "bun test test/component-store.test.ts"
fi

# Components' definitions: Convex's package and bunvex's, the same calls (STUDY-153 PR 1).
if ! bun test test/component-definitions.test.ts; then
  fail "A component definition differs." "bun test test/component-definitions.test.ts"
fi

# What the log stream says about each call, compared on both (STUDY-174 §5, Q5): the cache's hits and misses and
# their expiry, the read-limit warning and error, unawaited operations, an HTTP action's log lines. About 40 s,
# most of it the cache file's 19 s wait.
for f in cache-metadata read-count unawaited-operations http-action-log-route; do
  if ! bun test "test/$f.test.ts"; then
    fail "The log stream's metadata differs ($f)." "bun test test/$f.test.ts"
  fi
done

end=$(( $(date +%s) + MINUTES * 60 ))
batches=0
while [ "$(date +%s)" -lt "$end" ]; do
  seed=$(( (RANDOM << 15 | RANDOM) ))
  echo "batch $((batches + 1)): DIFF_SEED=$seed DIFF_RUNS=$DIFF_RUNS"
  if ! DIFF_SEED=$seed bun test test/generated.test.ts; then
    fail "Generated programs differ (seed $seed, $DIFF_RUNS programs)." \
      "DIFF_SEED=$seed DIFF_RUNS=$DIFF_RUNS bun test test/generated.test.ts"
  fi
  batches=$((batches + 1))
done
echo "no difference: the fixed programs, then $batches batches of $DIFF_RUNS generated programs"

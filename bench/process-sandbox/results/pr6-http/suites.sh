#!/usr/bin/env bash
# suites.sh <tree> <vm|process> <outdir> [suite...]: the HTTP-action parity suites of one tree under one executor.
set -u
T=$1; X=$2; O=$3; shift 3
SUITES=${*:-"server examples cli differential"}
mkdir -p $O
export PATH=/root/bunvex-pr6/bin:$PATH
if [ "$X" = process ]; then export BUNVEX_FUNCTION_SANDBOX=process BUNVEX_FUNCTION_SANDBOX_ISOLATION=none; PRE="--preload ./packages/sandbox/test/process-preload.ts"; else PRE=""; fi
cd $T
SERVER="action-end action-nested-error-frames code-version component-http component-tree engine-error-frames http-actions http-action-content-type router serve-after-code-ready source-position cors"
for s in $SUITES; do
  case $s in
    server) files=""; for f in $SERVER; do files="$files packages/server/test/$f.test.ts"; done
            bun test $PRE $files > $O/server.log 2>&1 ;;
    examples) (cd examples && BUNVEX_FREEZE_ENGINE_VALUES=1 bun test --timeout 120000) > $O/examples.log 2>&1 ;;
    cli) bun test $PRE packages/cli/test/deploy.test.ts > $O/cli.log 2>&1 ;;
    differential) (cd packages/differential && bun test) > $O/differential.log 2>&1 ;;
  esac
  echo "$s: $(grep -E '^ *[0-9]+ (pass|fail|skip)' $O/$s.log | tr -s ' ' | tr '\n' ' ')"
done

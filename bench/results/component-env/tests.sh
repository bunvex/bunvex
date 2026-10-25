#!/bin/bash
# The component-env PR's test runs on the VPS (each output in ~/bunvex-component-env/out/).
R=~/bunvex-component-env
export PATH=$R/bin:$PATH
mkdir -p $R/out
SUITES="packages/server/test/component-env.test.ts $(cat ~/bunvex-pr7/server-suites.txt)"
# 1. base (origin/main) with the new tests: they must fail there.
cp $R/head/packages/server/test/component-env.test.ts $R/base/packages/server/test/
cp $R/head/packages/differential/test/component-env.test.ts $R/base/packages/differential/test/
cp -r $R/head/packages/differential/component-env-app $R/base/packages/differential/
(cd $R/base && bun test packages/server/test/component-env.test.ts) > $R/out/base-server.txt 2>&1
(cd $R/base/packages/differential && bun test test/component-env.test.ts) > $R/out/base-diff.txt 2>&1
# 2. head under vm: the server's component suites, the whole server package, the differential's component files.
(cd $R/head && bun test $SUITES) > $R/out/head-suites-vm.txt 2>&1
(cd $R/head && bun test --isolate packages/server) > $R/out/head-server-all.txt 2>&1
(cd $R/head/packages/differential && bun test test/component-env.test.ts test/component-store.test.ts test/component-definitions.test.ts test/nested-errors.test.ts test/read-count.test.ts) > $R/out/head-diff.txt 2>&1
# 3. #822 with this branch merged in, under vm and process.
for sb in vm process; do
  if [ $sb = process ]; then export BUNVEX_FUNCTION_SANDBOX=process BUNVEX_FUNCTION_SANDBOX_ISOLATION=none; else unset BUNVEX_FUNCTION_SANDBOX BUNVEX_FUNCTION_SANDBOX_ISOLATION; fi
  (cd $R/m822 && bun test --preload ./packages/sandbox/test/process-preload.ts $SUITES) > $R/out/m822-suites-$sb.txt 2>&1
  (cd $R/m822/packages/differential && bun test test/component-env.test.ts) > $R/out/m822-diff-$sb.txt 2>&1
done
unset BUNVEX_FUNCTION_SANDBOX BUNVEX_FUNCTION_SANDBOX_ISOLATION
(cd $R/m822 && bun test packages/sandbox/test/component-parity.test.ts) > $R/out/m822-parity.txt 2>&1
# #822 alone, process, with the new server test: the bug under process before this fix.
cp $R/head/packages/server/test/component-env.test.ts $R/pr822/packages/server/test/
(cd $R/pr822 && BUNVEX_FUNCTION_SANDBOX=process BUNVEX_FUNCTION_SANDBOX_ISOLATION=none bun test --preload ./packages/sandbox/test/process-preload.ts packages/server/test/component-env.test.ts) > $R/out/pr822-env-process.txt 2>&1
echo done > $R/out/tests.done

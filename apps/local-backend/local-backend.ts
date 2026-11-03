// `bunvex-local-backend` (STUDY-40 L1, STUDY-39): the backend as one executable, the counterpart of Convex's
// precompiled `convex-local-backend`. `bun build --compile` cannot follow the persistence drivers' computed
// imports, so `@bunvex/persistence/executable` imports them and their database clients and registers them for the
// loaders.
import "@bunvex/persistence/executable";
import { createProcessExecutor } from "@bunvex/sandbox";
import { localBackendMain } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";

// The function sandbox (AD-44, STUDY-171 §8): `BUNVEX_FUNCTION_SANDBOX=process` runs queries and mutations in its
// children. The server cannot import it (its child runs the server's loader), so it is provided here.
provideProcessExecutor(createProcessExecutor);

// The version is the release's (set at build), else the package's (the published packages' fixed group).
declare const BUNVEX_BUILD_VERSION: string | undefined;
const version =
  typeof BUNVEX_BUILD_VERSION === "string" ? BUNVEX_BUILD_VERSION : (await import("./package.json")).version;

process.exit(
  await localBackendMain(
    process.argv.slice(2),
    {
      env: process.env,
      cwd: process.cwd(),
      out: (l) => process.stdout.write(`${l}\n`),
      err: (l) => process.stderr.write(`${l}\n`),
    },
    version,
  ),
);

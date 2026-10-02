// `bunvex-local-backend` (STUDY-40 L1, STUDY-39): the backend as one executable, the counterpart of Convex's
// precompiled `convex-local-backend`. `bun build --compile` cannot follow the persistence drivers' computed
// imports, so they and their database clients are imported here and registered for the loaders.
import { provideBundledModules } from "@bunvex/core";
import * as mongodbPersistence from "@bunvex/persistence/mongodb";
import * as mysqlPersistence from "@bunvex/persistence/mysql";
import * as postgresPersistence from "@bunvex/persistence/postgres";
import { localBackendMain } from "@bunvex/server";
import * as mongodb from "mongodb";
import * as mysql2 from "mysql2/promise";
import postgres from "postgres";

provideBundledModules({
  "@bunvex/persistence/postgres": postgresPersistence,
  "@bunvex/persistence/mysql": mysqlPersistence,
  "@bunvex/persistence/mongodb": mongodbPersistence,
  postgres,
  "mysql2/promise": mysql2,
  mongodb,
});

// The version is the release's (set at build), else the package's.
declare const BUNVEX_BUILD_VERSION: string | undefined;
const version =
  typeof BUNVEX_BUILD_VERSION === "string" ? BUNVEX_BUILD_VERSION : (await import("../package.json")).version;

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

// The standalone executable's entry (STUDY-39): `bunvex` as one file, the counterpart of Convex's
// precompiled `convex-local-backend`. `bun build --compile` cannot follow the persistence drivers' computed
// imports, so they and their database clients are imported here and registered for the loaders.
import { provideBundledModules } from "@bunvex/core";
import * as mongodbPersistence from "@bunvex/persistence/mongodb";
import * as mysqlPersistence from "@bunvex/persistence/mysql";
import * as postgresPersistence from "@bunvex/persistence/postgres";
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

const { main } = await import("@bunvex/cli");
process.exit(await main(process.argv.slice(2)));

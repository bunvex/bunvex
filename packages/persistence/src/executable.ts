// The drivers inside `bunvex-local-backend` (STUDY-39, STUDY-194 step v). `bun build --compile` cannot follow the
// drivers' computed imports, so this module imports them and their database clients and registers them for the
// loaders (`bundledModule`). The executable's entry imports it, and so does each execution worker there: a Worker
// has a registry of its own. `scripts/build-binary.ts` embeds it as an entry point of its own.
import { provideBundledModules } from "@bunvex/core";
import * as mysql2 from "mysql2/promise";
import postgres from "postgres";
import * as mysqlPersistence from "./mysql.ts";
import * as postgresPersistence from "./postgres.ts";

provideBundledModules({
  "@bunvex/persistence/postgres": postgresPersistence,
  "@bunvex/persistence/mysql": mysqlPersistence,
  postgres,
  "mysql2/promise": mysql2,
});

// The persistence configuration read from the environment: the remote drivers' call timeouts (STUDY-25 L3)
// under Convex's names for Postgres and MySQL.
import { expect, test } from "bun:test";
import { persistenceConfigFromEnv } from "../src/persistence.ts";

test("each remote driver reads its call timeout from its own variable, in seconds", () => {
  expect(persistenceConfigFromEnv({ PERSISTENCE: "postgres", POSTGRES_TIMEOUT_SECONDS: "5" }).timeoutMs).toBe(5000);
  expect(persistenceConfigFromEnv({ PERSISTENCE: "mysql", MYSQL_TIMEOUT_SECONDS: "2.5" }).timeoutMs).toBe(2500);
  expect(persistenceConfigFromEnv({ PERSISTENCE: "mongodb", MONGODB_TIMEOUT_SECONDS: "7" }).timeoutMs).toBe(7000);
  // another driver's variable is ignored; unset leaves the driver's default
  expect(persistenceConfigFromEnv({ PERSISTENCE: "postgres", MYSQL_TIMEOUT_SECONDS: "5" }).timeoutMs).toBeUndefined();
  expect(persistenceConfigFromEnv({ PERSISTENCE: "sqlite" }).timeoutMs).toBeUndefined();
});

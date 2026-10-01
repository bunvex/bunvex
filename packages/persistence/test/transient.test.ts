// Which errors each remote driver calls transient (STUDY-25 L4/L5). Errors are built in the shapes the native
// drivers produce; the drivers' behaviour against real stores is checked by the conformance suite (K20, K21).
import { describe, expect, test } from "bun:test";
import { DatabaseTimeoutError, LeaseLostError, retriedGroupLanded, UnsureCommitError } from "@bunvex/core/persistence";
import { MongoPersistence, operational as mongoOperational } from "../src/mongodb.ts";
import { MysqlPersistence, operational as mysqlOperational } from "../src/mysql.ts";
import { connectionLost, PostgresPersistence } from "../src/postgres.ts";

const err = (fields: Record<string, unknown>, message = "x") => Object.assign(new Error(message), fields);
const named = (name: string, fields: Record<string, unknown> = {}) => {
  const e = err(fields);
  Object.defineProperty(e, "name", { value: name });
  return e;
};
// isTransient reads no instance state: call it on the prototype.
const pgTransient = (e: unknown) => PostgresPersistence.prototype.isTransient.call(null, e);
const mysqlTransient = (e: unknown) => MysqlPersistence.prototype.isTransient.call(null, e);
const mongoTransient = (e: unknown) => MongoPersistence.prototype.isTransient.call(null, e);
const timeout = new DatabaseTimeoutError("Test", 1);
const never = [new LeaseLostError(), new UnsureCommitError("x"), new Error("boom"), null, undefined, "text"];

describe("Postgres (Convex: only timeouts; bunvex: lost connections too, DV-123)", () => {
  test("a flush retries timeouts and lost connections", () => {
    expect(pgTransient(timeout)).toBe(true);
    for (const code of ["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "ECONNRESET", "EPIPE", "57P01", "08006"])
      expect(pgTransient(err({ code }))).toBe(true);
    for (const code of ["40001", "40P01", "23505", "55P03", "42P01"]) expect(pgTransient(err({ code }))).toBe(false);
    for (const e of never) expect(pgTransient(e)).toBe(false);
  });
  test("a lost connection (read retries, and a flush whose transaction had not begun)", () => {
    for (const code of ["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECTION_ENDED", "ECONNRESET", "EPIPE"])
      expect(connectionLost(err({ code }))).toBe(true);
    for (const code of ["57P01", "57P02", "57P03", "08006", "08003"]) expect(connectionLost(err({ code }))).toBe(true);
    // Serialization failures, deadlocks and duplicate keys are not connection errors (Convex does not
    // classify them either).
    for (const code of ["40001", "40P01", "23505", "55P03", "42P01"]) expect(connectionLost(err({ code }))).toBe(false);
    expect(connectionLost(timeout)).toBe(false);
  });
});

describe("MySQL (as Convex's classify_mysql_error)", () => {
  test("operational errors and timeouts are transient", () => {
    expect(mysqlTransient(timeout)).toBe(true);
    for (const code of ["PROTOCOL_CONNECTION_LOST", "ECONNRESET", "ECONNREFUSED", "EPIPE", "POOL_CLOSED"])
      expect(mysqlOperational(err({ code, fatal: true }))).toBe(true);
    for (const errno of [1290, 2013, 1053, 1040]) expect(mysqlTransient(err({ errno }))).toBe(true);
    expect(mysqlOperational(err({ errno: 1105 }, "vttablet: primary is not serving"))).toBe(true);
    expect(mysqlOperational(err({}, "Can't add new command when connection is in closed state"))).toBe(true);
  });
  test("deadlocks, lock waits, duplicate keys and other errors are not", () => {
    for (const errno of [1213, 1205, 1062, 1064, 1105]) expect(mysqlTransient(err({ errno }))).toBe(false);
    for (const e of never) expect(mysqlTransient(e)).toBe(false);
  });
});

describe("MongoDB (no Convex counterpart: as the MySQL list)", () => {
  test("network errors, a server that is not serving, and timeouts are transient", () => {
    expect(mongoTransient(timeout)).toBe(true);
    for (const name of [
      "MongoNetworkError",
      "MongoNetworkTimeoutError",
      "MongoServerSelectionError",
      "MongoPoolClearedError",
      "MongoWaitQueueTimeoutError",
    ])
      expect(mongoOperational(named(name))).toBe(true);
    // A subclass of MongoNetworkError counts too.
    class MongoNetworkError extends Error {}
    class MongoSomeNetworkError extends MongoNetworkError {}
    expect(mongoOperational(new MongoSomeNetworkError())).toBe(true);
    for (const code of [6, 7, 89, 9001, 91, 189, 10107, 11600, 11602, 13435, 13436])
      expect(mongoTransient(named("MongoServerError", { code }))).toBe(true);
  });
  test("write conflicts, duplicate keys and other errors are not", () => {
    for (const code of [112, 11000, 50, 2]) expect(mongoTransient(named("MongoServerError", { code }))).toBe(false);
    for (const e of never) expect(mongoTransient(e)).toBe(false);
  });
});

describe("a retried group that landed (DV-124: one rule on every store)", () => {
  test("our epoch with max_ts at or above the group's top: landed", () => {
    expect(retriedGroupLanded({ epoch: 3, maxTs: 100 }, 3, 100)).toBe(true);
    expect(retriedGroupLanded({ epoch: 3, maxTs: 120 }, 3, 100)).toBe(true);
    expect(retriedGroupLanded({ epoch: 3, maxTs: 99 }, 3, 100)).toBe(false);
  });
  test("another epoch, or no lease record: the lease is lost", () => {
    expect(() => retriedGroupLanded({ epoch: 4, maxTs: 100 }, 3, 100)).toThrow(LeaseLostError);
    expect(() => retriedGroupLanded({ epoch: 2, maxTs: 50 }, 3, 100)).toThrow(LeaseLostError);
    expect(() => retriedGroupLanded(null, 3, 100)).toThrow(LeaseLostError);
  });
});

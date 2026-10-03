// The line-coverage floors of the critical files (TEST-01 §4), checked by `bun run coverage` in CI.
//
// One entry per file: the floor (percent of lines hit by the root `bun test`), the heart area it belongs to
// (TEST-01 §2) and why the file is critical. A floor is the file's coverage when it was set, minus a small
// margin (about 2 points, rounded down), so unrelated changes do not trip it but a lost test file does.
//
// Changing a floor:
// - raise it when a PR adds tests to the file: run `bun run coverage`, take the new value, subtract the margin;
// - lower it only with a reason in the PR (e.g. new defensive code that tests cannot reach), and the owner's
//   review;
// - a new critical file gets an entry here with its area and reason;
// - a renamed or removed file: move or drop its entry (the check fails on a floor whose file is not in the
//   report, so a stale entry cannot pass silently).

export type Floor = { floor: number; area: Area; why: string };
export type Area =
  | "transactions/OCC"
  | "value encoding/order"
  | "persistence durability"
  | "invalidation/cache"
  | "sync/reconnect"
  | "determinism"
  | "scheduler exactly-once"
  | "admin keys";

export const FLOORS: Record<string, Floor> = {
  // Transactions and OCC.
  "packages/core/src/tx.ts": { floor: 97, area: "transactions/OCC", why: "reads, writes, index ranges, read sets" },
  "packages/core/src/committer.ts": {
    floor: 95,
    area: "transactions/OCC",
    why: "serial commit, OCC validation, ts order",
  },
  "packages/core/src/read-set-index.ts": {
    floor: 97,
    area: "transactions/OCC",
    why: "which writes conflict with which reads",
  },
  // Value encoding and order.
  "packages/values/src/sorting.ts": {
    floor: 98,
    area: "value encoding/order",
    why: "index key bytes: the order of every index",
  },
  "packages/values/src/value.ts": { floor: 95, area: "value encoding/order", why: "compareValues, the wire JSON form" },
  "packages/values/src/commit-ts.ts": {
    floor: 98,
    area: "value encoding/order",
    why: "the commit timestamp placeholder",
  },
  "packages/core/src/keyenc.ts": { floor: 98, area: "value encoding/order", why: "index keys and their range bounds" },
  // Persistence durability. split.ts is also exercised by the SQL drivers' conformance jobs; in the root run
  // scan.property.test.ts covers it against the split-key model.
  "packages/core/src/persistence/split.ts": {
    floor: 84,
    area: "persistence durability",
    why: "keys over 2500 bytes on SQL stores",
  },
  "packages/core/src/persistence/scan.ts": {
    floor: 96,
    area: "persistence durability",
    why: "latest-version scans every driver shares",
  },
  "packages/core/src/persistence/memory.ts": {
    floor: 98,
    area: "persistence durability",
    why: "the memory store's log replay",
  },
  "packages/core/src/persistence/sqlite.ts": {
    floor: 98,
    area: "persistence durability",
    why: "the embedded SQL store",
  },
  "packages/server/src/persistence.ts": {
    floor: 94,
    area: "persistence durability",
    why: "which store a deployment opens",
  },
  // Invalidation and the query cache.
  "packages/core/src/query-cache.ts": {
    floor: 98,
    area: "invalidation/cache",
    why: "cached query results and their invalidation",
  },
  "packages/core/src/system-reader.ts": {
    floor: 98,
    area: "invalidation/cache",
    why: "db.system: the public projection of system tables",
  },
  // Sync and reconnect.
  "packages/server/src/sync.ts": { floor: 97, area: "sync/reconnect", why: "the server side of the sync protocol" },
  "packages/protocol/src/v1.ts": { floor: 97, area: "sync/reconnect", why: "the wire messages" },
  "packages/client/src/web-socket-manager.ts": {
    floor: 98,
    area: "sync/reconnect",
    why: "reconnects, backoff, transition chunks",
  },
  "packages/client/src/base-client.ts": {
    floor: 91,
    area: "sync/reconnect",
    why: "query set, versions, optimistic updates",
  },
  // Determinism.
  "packages/core/src/schema-json.ts": {
    floor: 98,
    area: "determinism",
    why: "the schema a push compares: same input, same JSON",
  },
  // Scheduler exactly-once.
  "packages/server/src/scheduler.ts": {
    floor: 96,
    area: "scheduler exactly-once",
    why: "scheduled functions run once",
  },
  "packages/server/src/cron-executor.ts": { floor: 97, area: "scheduler exactly-once", why: "crons run once per slot" },
  // Admin keys.
  "packages/server/src/admin-keys.ts": { floor: 98, area: "admin keys", why: "issuing and checking admin keys" },
  "packages/server/src/local-backend.ts": {
    floor: 98,
    area: "admin keys",
    why: "the self-hosted binary: secret checks, keygen",
  },
};

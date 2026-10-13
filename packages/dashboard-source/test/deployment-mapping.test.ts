// The system documents and metric answers of STUDY-149 PR 5 as the contract shows them, without a server: the
// shapes are the ones Convex's backend sends (checked against its binary in packages/differential).
import { describe, expect, test } from "bun:test";
import { auditEventOf, cronJobOf, cronRunOf, storedFileOf } from "../src/deployment.ts";
import { concurrencyOf, invalidationsOf } from "../src/metrics.ts";
import { argsOfBytes, encodeValue, msOfNs } from "../src/wire.ts";

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const t = (secs: number) => ({ secs_since_epoch: secs, nanos_since_epoch: 0 });
const W = { start: 0, end: 3_000, numBuckets: 3 };

describe("values", () => {
  test("int64 as 8 little-endian bytes, bytes in base64, as Convex's JSON", () => {
    expect(encodeValue({ n: 1n, m: -1n, b: bytes("hi"), a: [2n], u: undefined })).toEqual({
      n: { $integer: "AQAAAAAAAAA=" },
      m: { $integer: "//////////8=" },
      b: { $bytes: "aGk=" },
      a: [{ $integer: "AgAAAAAAAAA=" }],
    });
  });

  test("arguments kept as the bytes of their JSON array: the first element", () => {
    expect(argsOfBytes(bytes('[{"i":1,"big":{"$integer":"AQAAAAAAAAA="}}]'))).toEqual({
      i: 1,
      big: { $integer: "AQAAAAAAAAA=" },
    });
    expect(argsOfBytes(undefined)).toEqual({});
  });

  test("nanoseconds to milliseconds", () => {
    expect(msOfNs(1_791_835_586_331_000_090n)).toBe(1_791_835_586_331);
  });
});

describe("cron jobs and their runs", () => {
  const log = {
    name: "tick",
    ts: 1_000_000_000n,
    udfPath: "jobs.js:work",
    udfArgs: bytes("[{}]"),
    status: { type: "success" as const, result: { type: "default", value: "null" } },
    logLines: { logLines: ["a"], isTruncated: false },
    executionTime: 0.25,
  };

  test("a run: Convex's statuses, the time in ms, the duration in ms", () => {
    expect(cronRunOf(log)).toEqual({
      name: "tick",
      time: 1000,
      function: "jobs:work",
      status: "success",
      durationMs: 250,
      logLines: ["a"],
    });
    expect(cronRunOf({ ...log, status: { type: "err", error: "boom" } })).toMatchObject({
      status: "failure",
      error: "boom",
    });
    expect(cronRunOf({ ...log, status: { type: "canceled", num_canceled: 3n } })).toMatchObject({
      status: "skipped",
      skippedRuns: 3,
    });
  });

  test("a job: its schedule with numbers, its arguments, the next run, running while in progress", () => {
    const job = {
      name: "nightly",
      cronSpec: {
        udfPath: "jobs.js:other",
        udfArgs: bytes('[{"i":-2}]'),
        cronSchedule: { type: "daily", hourUTC: 3n, minuteUTC: 30n },
      },
      lastRun: log,
      nextRun: { nextTs: 5_000_000_000n, state: { type: "inProgress" } },
    };
    expect(cronJobOf(job)).toEqual({
      name: "nightly",
      function: "jobs:other",
      args: { i: -2 },
      schedule: { type: "daily", hourUTC: 3, minuteUTC: 30 },
      nextRun: 5000,
      lastRun: cronRunOf(log),
      running: true,
    });
  });
});

test("a file: Convex's FileMetadata", () => {
  expect(
    storedFileOf({ _id: "kg1", _creationTime: 5, sha256: "x", size: 7n, contentType: "text/plain", url: "http://u" }),
  ).toEqual({ id: "kg1", creationTime: 5, sha256: "x", size: 7, contentType: "text/plain", url: "http://u" });
  expect(storedFileOf({ _id: "kg1", _creationTime: 5, sha256: "x", size: 7, url: "http://u" }).contentType).toBeNull();
});

test("an audit event: the system by name, a member as unknown, the metadata encoded", () => {
  const e = { _id: "hw1", _creationTime: 9, action: "delete_files", member_id: 0n, metadata: { n: 2n } };
  expect(auditEventOf(e)).toEqual({
    id: "hw1",
    time: 9,
    action: "delete_files",
    author: null,
    metadata: { n: { $integer: "AgAAAAAAAAA=" } },
  });
  expect(auditEventOf({ ...e, member_id: null, metadata: undefined })).toMatchObject({
    author: "system",
    metadata: {},
  });
});

describe("Health's metrics", () => {
  test("concurrency: Convex's gauges per kind, in order, others left out, a missing state empty", () => {
    const s = [
      [t(0), null],
      [t(1), 2],
      [t(2), 0],
    ] as [ReturnType<typeof t>, number | null][];
    const got = concurrencyOf(
      {
        "outstanding_functions:isolate:Mutation:running": s,
        "outstanding_functions:isolate:Query:queued": s,
        "outstanding_functions:isolate:Query:running": s,
        "outstanding_functions:node:Action:running": s,
        "outstanding_functions:node:Query:running": s,
        "outstanding_functions:isolate:Query:waiting": s,
        "other:isolate:Query:running": s,
      },
      W,
    );
    const values = [
      { time: 0, value: null },
      { time: 1000, value: 2 },
      { time: 2000, value: 0 },
    ];
    const none = [0, 1000, 2000].map((time) => ({ time, value: null }));
    expect(got).toEqual([
      { kind: "query", running: values, queued: values },
      { kind: "mutation", running: values, queued: none },
      { kind: "nodeAction", running: values, queued: none },
    ]);
  });

  test("invalidations: `<mutation>:<table>` split at the last colon; one mutation's are tables; the rest", () => {
    const s: [ReturnType<typeof t>, number | null][] = [
      [t(0), 1],
      [t(1), null],
      [t(2), 3],
    ];
    expect(
      invalidationsOf(
        [
          ["messages.js:send:messages", s],
          ["lib/a.js:default:users", s],
          ["_rest", s],
        ],
        W,
      ).map((x) => [x.function, x.table]),
    ).toEqual([
      ["messages:send", "messages"],
      ["lib/a:default", "users"],
      ["_rest", null],
    ]);
    expect(invalidationsOf([["messages", s]], W, "messages:send").map((x) => [x.function, x.table])).toEqual([
      ["messages:send", "messages"],
    ]);
  });
});

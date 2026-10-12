// The log stream (STUDY-149 §1.3): executions become lines and outcome lines as Convex's `processLogs`; the
// long-poll loop's cursor, back-off, reported failures and 403 stop; the history listed but not delivered.
import { describe, expect, test } from "bun:test";
import { DataSourceError, type LogEntry } from "@bunvex/dashboard/data-source";
import { type AdminHttp, ResponseError } from "../src/admin-http.ts";
import { backoffWithJitter, entriesOf, type FunctionExecution, LogStream, messageText } from "../src/logs.ts";

const ids = () => {
  let n = 0;
  return () => String(++n).padStart(4, "0");
};

const completion = (o: Partial<Extract<FunctionExecution, { kind: "Completion" }>> = {}): FunctionExecution => ({
  kind: "Completion",
  udfType: "Mutation",
  identifier: "messages.js:send",
  timestamp: 1_700_000_000.5,
  logLines: [],
  executionTime: 0.012,
  success: null,
  error: null,
  requestId: "r1",
  executionId: "e1",
  parentExecutionId: null,
  ...o,
});

describe("entriesOf", () => {
  test("each line, then the outcome line with the execution; paths as the dashboard shows them", () => {
    const out = entriesOf(
      [
        completion({
          logLines: [
            {
              messages: ["'sending'", "'a\\'b'", "3"],
              isTruncated: false,
              timestamp: 1_700_000_000_100,
              level: "WARN",
            },
            "[ERROR] old style",
          ],
          usageStats: { databaseReadBytes: 10, databaseWriteBytes: 20, storageReadBytes: 1, memoryUsedMb: 64 },
          returnBytes: 5,
          identityType: "instance_admin",
          parentExecutionId: "e0",
        }),
      ],
      ids(),
    );
    const common = {
      function: { path: "messages:send", kind: "mutation" },
      requestId: "r1",
      executionId: "e1",
      parentExecutionId: "e0",
    };
    expect(out).toEqual([
      { id: "0001", time: 1_700_000_000_100, level: "warn", message: "sending a'b 3", ...common },
      { id: "0002", time: 1_700_000_000_500, level: "error", message: "old style", ...common },
      {
        id: "0003",
        time: 1_700_000_000_500,
        level: "info",
        message: "",
        ...common,
        execution: {
          status: "success",
          durationMs: 12,
          usage: { memoryMb: 64, databaseReadBytes: 10, databaseWriteBytes: 20, fileReadBytes: 1, returnBytes: 5 },
          identity: "admin",
        },
      },
    ] as LogEntry[]);
  });

  test("a failure is an error outcome with its message; an HTTP action fails by its status", () => {
    const [failed] = entriesOf([completion({ error: "Uncaught Error: no" })], ids());
    expect([failed!.level, failed!.message, failed!.execution?.status]).toEqual([
      "error",
      "Uncaught Error: no",
      "failure",
    ]);
    const http = (status: string) =>
      entriesOf([completion({ udfType: "HttpAction", identifier: "GET /hook", success: { status } })], ids())[0]!;
    expect(http("204").execution?.status).toBe("success");
    expect(http("500").execution?.status).toBe("failure");
    expect(http("500").function).toEqual({ path: "GET /hook", kind: "action" });
  });

  test("an action's Progress lines have no outcome; links and identities pass through", () => {
    const out = entriesOf(
      [
        {
          kind: "Progress",
          udfType: "Action",
          identifier: "jobs.js:run",
          timestamp: 1,
          logLines: [{ messages: ["'step'"], isTruncated: true, timestamp: 1000, level: "LOG" }],
          requestId: "r",
          executionId: "e",
        },
        completion({
          identityType: "member_acting_user",
          links: { trace: { traceId: "a".repeat(32), spanId: "b".repeat(16) } },
        }),
      ],
      ids(),
    );
    expect(out[0]).toMatchObject({ level: "info", message: "step (truncated due to length)" });
    expect(out[0]!.execution).toBeUndefined();
    expect(out[1]!.execution?.identity).toBe("acting_as_user");
    expect(out[1]!.execution?.links).toEqual({ trace: { traceId: "a".repeat(32), spanId: "b".repeat(16) } });
  });

  test("messageText unquotes only whole quoted strings, as Convex's messagesToString", () => {
    expect(messageText(["'x\\ny'", "{ a: 'b' }", "'"], false)).toBe("x\ny { a: 'b' } '");
  });
});

describe("backoffWithJitter", () => {
  test("500 ms doubling to 16 s, within ±50 %", () => {
    expect([1, 2, 3, 6, 10].map((n) => backoffWithJitter(n, () => 0.5))).toEqual([500, 1000, 2000, 16_000, 16_000]);
    expect(backoffWithJitter(1, () => 0)).toBe(250);
    expect(backoffWithJitter(1, () => 1)).toBe(750);
  });
});

/** An AdminHttp whose stream answers from a script; each request waits for its answer. */
function fakeHttp() {
  const asked: string[] = [];
  const pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const http = {
    json(path: string, req?: { signal?: AbortSignal }) {
      asked.push(path);
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        req?.signal?.addEventListener("abort", () => reject(req.signal?.reason));
      });
    },
  } as unknown as AdminHttp;
  const next = async (n = asked.length + 1) => {
    for (let i = 0; i < 500 && asked.length < n; i++) await Bun.sleep(1);
    expect(asked.length).toBe(n);
  };
  return {
    http,
    asked,
    next,
    answer: (entries: FunctionExecution[], newCursor: number) => pending.shift()!.resolve({ entries, newCursor }),
    fail: (e: unknown) => pending.shift()!.reject(e),
  };
}

describe("LogStream", () => {
  test("asks from cursor 0, then each answer's newCursor; lists newest first and pages back", async () => {
    const f = fakeHttp();
    const logs = new LogStream(f.http, { firstAnswerMs: 5_000 });
    const listed = logs.list({ numItems: 2, cursor: null });
    await f.next(1);
    expect(f.asked[0]).toBe("/api/app_metrics/stream_function_logs?cursor=0");
    f.answer(
      [completion({ executionId: "a" }), completion({ executionId: "b" }), completion({ executionId: "c" })],
      42,
    );
    const first = await listed;
    expect(first.page.map((e) => e.executionId)).toEqual(["c", "b"]);
    expect(first.isDone).toBe(false);
    const second = await logs.list({ numItems: 2, cursor: first.continueCursor });
    expect(second.page.map((e) => e.executionId)).toEqual(["a"]);
    expect(second.isDone).toBe(true);
    await f.next(2);
    expect(f.asked[1]).toBe("/api/app_metrics/stream_function_logs?cursor=42");
    // a cursor is bound to its filter
    const other = await logs.list({ numItems: 2, cursor: first.continueCursor, levels: ["error"] }).catch((e) => e);
    expect((other as DataSourceError).code).toBe("invalid_request");
    logs.close();
  });

  test("the first answer within the grace is history: listed, not delivered; later answers are delivered", async () => {
    const f = fakeHttp();
    const logs = new LogStream(f.http, { firstAnswerMs: 5_000 });
    const got: LogEntry[] = [];
    logs.watch(
      { function: "messages:send" },
      (e) => got.push(...e),
      () => {},
    );
    await f.next(1);
    f.answer([completion({ executionId: "old" })], 1);
    await f.next(2);
    expect(got).toEqual([]);
    f.answer([completion({ executionId: "new" }), completion({ identifier: "other.js:f", executionId: "x" })], 2);
    await f.next(3);
    expect(got.map((e) => e.executionId)).toEqual(["new"]);
    logs.close();
  });

  test("an empty log: after the grace, list reads it empty and the first answer is delivered", async () => {
    const f = fakeHttp();
    const logs = new LogStream(f.http, { firstAnswerMs: 20 });
    const got: LogEntry[] = [];
    logs.watch(
      {},
      (e) => got.push(...e),
      () => {},
    );
    expect(await logs.list({ numItems: 5, cursor: null })).toEqual({ page: [], isDone: true, continueCursor: "" });
    f.answer([completion()], 1);
    await f.next(2);
    expect(got).toHaveLength(1);
    logs.close();
  });

  test("failures back off with a growing count, are reported after 5 in a row, and a success resets them", async () => {
    const f = fakeHttp();
    const waits: number[] = [];
    const logs = new LogStream(f.http, {
      firstAnswerMs: 1,
      backoff: (n) => {
        waits.push(n);
        return 1;
      },
    });
    const errors: DataSourceError[] = [];
    logs.watch(
      {},
      () => {},
      (e) => errors.push(e),
    );
    for (let i = 1; i <= 5; i++) {
      await f.next(i);
      f.fail(new DataSourceError("unavailable", "down"));
    }
    await f.next(6);
    expect(errors).toEqual([]);
    f.fail(new DataSourceError("unavailable", "down"));
    await f.next(7);
    expect(errors.map((e) => e.code)).toEqual(["unavailable"]);
    f.answer([], 0);
    await f.next(8);
    f.fail(new DataSourceError("unavailable", "down"));
    await f.next(9);
    expect(waits).toEqual([1, 2, 3, 4, 5, 6, 1]);
    logs.close();
  });

  test("a 403 stops the loop: watchers hear unauthorized, list rejects, and nothing more is asked", async () => {
    const f = fakeHttp();
    const logs = new LogStream(f.http, { firstAnswerMs: 5_000 });
    const errors: DataSourceError[] = [];
    logs.watch(
      {},
      () => {},
      (e) => errors.push(e),
    );
    await f.next(1);
    f.fail(new ResponseError(403, "You do not have permission"));
    const listed = await logs.list({ numItems: 1, cursor: null }).catch((e) => e);
    expect((listed as DataSourceError).code).toBe("unauthorized");
    expect(errors.map((e) => e.code)).toEqual(["unauthorized"]);
    await Bun.sleep(20);
    expect(f.asked).toHaveLength(1);
    logs.close();
  });

  test("a 401 (a refused key) backs off and asks again, as any failure but a 403", async () => {
    const f = fakeHttp();
    const logs = new LogStream(f.http, { firstAnswerMs: 1, backoff: () => 1 });
    logs.watch(
      {},
      () => {},
      () => {},
    );
    await f.next(1);
    f.fail(new ResponseError(401, "The provided admin key was invalid for this instance"));
    await f.next(2);
    logs.close();
  });

  test("keeps at most MAX_LOGS entries, dropping the oldest", async () => {
    const f = fakeHttp();
    const logs = new LogStream(f.http, { firstAnswerMs: 5_000 });
    const listed = logs.list({ numItems: 20_000, cursor: null });
    await f.next(1);
    f.answer(
      Array.from({ length: 10_005 }, (_, i) => completion({ executionId: String(i) })),
      1,
    );
    const { page, isDone } = await listed;
    expect(page).toHaveLength(10_000);
    expect(isDone).toBe(true);
    expect(page.at(-1)?.executionId).toBe("5");
    logs.close();
  });
});

// The cron and `_udf_config` rows against Convex's (STUDY-134, DV-425): what bunvex stores, compared with the
// rows of a Convex deployment's database (./convex-rows), field types included.
import { expect, test } from "bun:test";
import {
  CRON_JOB_LOGS_TABLE,
  CRON_JOBS_TABLE,
  CRON_NEXT_RUN_TABLE,
  defineSchema,
  Engine,
  UDF_CONFIG_TABLE,
} from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { udfConfig } from "../src/code-store.ts";
import { cronJobs, cronSpecs } from "../src/cron.ts";
import { applyCrons, completeRun, currentJob, insertLog, setCronState } from "../src/cron-model.ts";
import { argsOfBytes, cronSpecOf, cronSpecRow, cronSpecsRow, msOfNs, nsOfMs } from "../src/cron-rows.ts";
import { indexRows, shapeDiff, stored } from "./convex-rows/shape.ts";

async function withCron() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  // The app of the fixtures: crons.daily("daily tick", { hourUTC: 3, minuteUTC: 0 }, internal.fns.tick, { why: "cron" }).
  const c = cronJobs();
  c.daily("daily tick", { hourUTC: 3, minuteUTC: 0 }, "fns:tick", { why: "cron" });
  const specs = cronSpecs(c, (_id, name) => name.replace(":", ".js:"));
  await engine.mutation((db) => applyCrons(db, specs, Date.now(), { cronSplaySeconds: 0 }));
  const rows = (table: string) =>
    engine.query((db) => db.asSystem(() => db.query(table).collect())) as Promise<Record<string, unknown>[]>;
  return { engine, specs, rows };
}

test("_cron_jobs: Convex's SerializedCronSpec (int64 schedule, the arguments' JSON as bytes)", async () => {
  const { rows } = await withCron();
  const [job] = await rows(CRON_JOBS_TABLE);
  expect(shapeDiff(stored(job), indexRows("_cron_jobs")[0])).toEqual([]);
  // The very bytes Convex stores for these arguments, and the schedule's values.
  const convex = indexRows("_cron_jobs")[0]!.cronSpec as Record<string, Record<string, string>>;
  const ours = stored(job) as Record<string, Record<string, unknown>>;
  expect(ours.cronSpec!.udfArgs).toEqual(convex.udfArgs);
  expect(ours.cronSpec!.cronSchedule).toEqual(convex.cronSchedule);
});

test("_cron_next_run: int64 nanoseconds, as Convex's", async () => {
  const { rows } = await withCron();
  const [run] = await rows(CRON_NEXT_RUN_TABLE);
  expect(shapeDiff(stored(run), indexRows("_cron_next_run")[0])).toEqual([]);
  // Daily at 03:00 UTC: a whole minute, in nanoseconds.
  expect((run!.nextTs as bigint) % 60_000_000_000n).toBe(0n);
  expect(new Date(msOfNs(run!.nextTs as bigint)).getUTCHours()).toBe(3);
});

test("_cron_next_run in progress, then completed; _cron_job_logs as Convex's CronJobLog", async () => {
  const { engine, rows } = await withCron();
  const [first] = await rows(CRON_NEXT_RUN_TABLE);
  const job = (await engine.query((db) => currentJob(db, first!.cronJobId as string)))!;
  await engine.mutation((db) => setCronState(db, job, { type: "inProgress", requestId: "r1", executionId: "e1" }));
  expect((await rows(CRON_NEXT_RUN_TABLE))[0]!.state).toEqual({
    type: "inProgress",
    request_id: "r1",
    execution_id: "e1",
  });
  // Read back as bunvex's in-memory job.
  expect((await engine.query((db) => currentJob(db, job.id)))!.state).toEqual({
    type: "inProgress",
    requestId: "r1",
    executionId: "e1",
  });
  await engine.mutation(async (db) => {
    await insertLog(
      db,
      job,
      job.nextTs,
      { type: "success", result: { type: "default", value: { ok: 1n } } },
      { logLines: ["[LOG] 'hi'"], isTruncated: false },
      0.25,
    );
    await insertLog(
      db,
      job,
      job.nextTs,
      { type: "canceled", num_canceled: 3 },
      { logLines: [], isTruncated: false },
      0,
    );
    await completeRun(db, job, job.nextTs + 1, { cronSplaySeconds: 0 });
  });
  const [ok, canceled] = (await rows(CRON_JOB_LOGS_TABLE)).map((r) => stored(r) as Record<string, unknown>);
  const int64 = (v: bigint) => ({ $integer: Buffer.from(new BigInt64Array([v]).buffer).toString("base64") });
  expect(ok).toMatchObject({
    name: "daily tick",
    ts: int64(nsOfMs(job.nextTs)),
    udfPath: "fns.js:tick",
    udfArgs: (indexRows("_cron_jobs")[0]!.cronSpec as Record<string, unknown>).udfArgs,
    // Convex's `CronJobResult::Default`: the value's JSON text.
    status: { type: "success", result: { type: "default", value: '{"ok":{"$integer":"AQAAAAAAAAA="}}' } },
    logLines: { logLines: ["[LOG] 'hi'"], isTruncated: false },
    executionTime: 0.25,
  });
  expect(canceled!.status).toEqual({ type: "canceled", num_canceled: int64(3n) });
  const next = stored((await rows(CRON_NEXT_RUN_TABLE))[0]) as Record<string, unknown>;
  expect(next.prevTs).toEqual(int64(nsOfMs(job.nextTs)));
  expect(shapeDiff(next, indexRows("_cron_next_run")[0], ["prevTs"])).toEqual([]);
});

test("_modules.analyzeResult.cronSpecs: Convex's [{identifier, spec}]", async () => {
  const { specs } = await withCron();
  const convex = indexRows("_modules").find((m) => m.path === "crons.js")!.analyzeResult as Record<string, unknown>;
  const ours = stored(cronSpecsRow(Object.fromEntries(specs)));
  expect(shapeDiff({ cronSpecs: ours }, { cronSpecs: convex.cronSpecs })).toEqual([]);
  expect(ours).toEqual(convex.cronSpecs);
  expect(cronSpecsRow(null)).toBeNull();
});

test("a spec survives its row: every schedule, an absent minute as null", () => {
  const c = cronJobs();
  c.interval("i", { minutes: 2 }, "m:f", { a: [1, "x"] });
  c.hourly("h", "m:f");
  c.hourly("h2", { minuteUTC: 7 }, "m:f");
  c.daily("d", { hourUTC: 5 }, "m:f");
  c.weekly("w", { dayOfWeek: "friday", hourUTC: 1, minuteUTC: 2 }, "m:f");
  c.monthly("mo", { day: 31, hourUTC: 23 }, "m:f");
  c.cron("c", "*/5 * * * *", "m:f");
  for (const spec of cronSpecs(c, (_i, n) => n).values()) {
    const row = cronSpecRow(spec);
    expect(cronSpecOf(row)).toEqual(spec);
    expect(argsOfBytes(row.udfArgs as ArrayBuffer)).toEqual(spec.udfArgs);
  }
  // The bytes as Convex's serde_json writes them: a float64 `1` as `1.0` (STUDY-133 §12 M8).
  const iRow = cronSpecRow(cronSpecs(c, (_i, n) => n).get("i")!);
  expect(new TextDecoder().decode(iRow.udfArgs as ArrayBuffer)).toBe('[{"a":[1.0,"x"]}]');
  const hourly = cronSpecRow(cronSpecs(c, (_i, n) => n).get("h")!).cronSchedule;
  expect(hourly).toEqual({ type: "hourly", minuteUTC: null });
  expect(cronSpecRow(cronSpecs(c, (_i, n) => n).get("i")!).cronSchedule).toEqual({ type: "interval", seconds: 120n });
});

test("_udf_config: the version a push sends, the seed as bytes, the time in int64 nanoseconds", async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const before = Date.now();
  const config = await udfConfig(engine, "1.46.0");
  const [row] = (await engine.query((db) => db.asSystem(() => db.query(UDF_CONFIG_TABLE).collect()))) as Record<
    string,
    unknown
  >[];
  expect(shapeDiff(stored(row), indexRows("_udf_config")[0])).toEqual([]);
  expect(row!.serverVersion).toBe("1.46.0");
  expect(msOfNs(row!.importPhaseUnixTimestamp as bigint)).toBeGreaterThanOrEqual(before);
  // Read back without a version: the stored one, the same seed and time.
  const again = await udfConfig(engine);
  expect(again.serverVersion).toBe("1.46.0");
  expect(again.timestamp).toBe(config.timestamp);
  expect([...again.seed]).toEqual([...config.seed]);
  // A push of another version: a new seed and time, as Convex's.
  const next = await udfConfig(engine, "1.47.0");
  expect([...next.seed]).not.toEqual([...config.seed]);
});

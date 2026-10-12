// STUDY-147: every knob the server reads, under Convex's name (the engine's are in core's knobs-env.test.ts).
// A process with each one set reads it; with each one set to something that does not parse, it keeps the
// defaults and starts, as Convex's `env_config`.
import { expect, test } from "bun:test";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures/knob-values.ts");

async function values(env: Record<string, string>) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^[A-Z][A-Z0-9_]+$/.test(k) && k in SET) delete base[k];
  const p = Bun.spawn([process.execPath, FIXTURE], { env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect(await p.exited).toBe(0);
  return { values: JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, number>, log: out + err };
}

/** A value for each knob, none its default. */
const SET: Record<string, string> = {
  UDF_METRICS_BUCKET_WIDTH_SECS: "46",
  UDF_METRICS_MAX_BUCKETS: "47",
  MAX_USER_MODULES: "48",
  ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS: "49",
  DATA_SYNC_PAGE_SIZE_LIMIT: "50",
  DATA_SYNC_BY_ID_FRESHNESS_SECONDS: "51",
  MAX_EXPIRED_SNAPSHOT_AGE_DAYS: "52",
  MAX_UDF_EXECUTION: "53",
  MAX_REACTOR_CALL_DEPTH: "54",
  HTTP_SERVER_TIMEOUT_SECONDS: "55",
  MAX_IMPORT_AGE_SECONDS: "56",
  V8_ACTION_USER_TIMEOUT_SECS: "57",
  LOG_MANAGER_AGGREGATION_INTERVAL: "58",
  SCHEDULED_JOB_EXECUTION_PARALLELISM: "59",
  SCHEDULER_OCC_INITIAL_BACKOFF_MS: "60",
  SCHEDULER_OCC_MAX_BACKOFF_MS: "61",
  SCHEDULED_JOB_INITIAL_BACKOFF_MS: "62",
  SCHEDULED_JOB_MAX_BACKOFF_SECS: "63",
  SCHEDULED_JOB_GARBAGE_COLLECTION_BATCH_SIZE: "68",
  SCHEDULED_JOB_GARBAGE_COLLECTION_DELAY: "69",
  SCHEDULED_JOB_GARBAGE_COLLECTION_INITIAL_BACKOFF_MS: "70",
  SCHEDULED_JOB_GARBAGE_COLLECTION_MAX_BACKOFF_SECS: "71",
  SYSTEM_TABLE_CLEANUP_FREQUENCY_SECONDS: "64",
  SNAPSHOT_LIST_LIMIT: "65",
  DOCUMENT_DELTAS_LIMIT: "66",
  MAX_JOBS_CANCEL_BATCH: "67",
};

test("each knob is read from the environment under Convex's name", async () => {
  const defaults = (await values({})).values;
  const { values: set, log } = await values(SET);
  expect(Object.keys(set).sort()).toEqual(Object.keys(SET).sort());
  for (const [k, v] of Object.entries(SET)) {
    expect([k, defaults[k]]).not.toEqual([k, Number(v)]);
    expect([k, set[k]]).toEqual([k, Number(v)]);
  }
  expect(log).toContain("Overriding MAX_REACTOR_CALL_DEPTH to 54 from environment");
}, 30_000);

test("a value that does not parse keeps the default, logged, and nothing fails", async () => {
  const defaults = (await values({})).values;
  const bad = Object.fromEntries(Object.keys(SET).map((k) => [k, "not a number"]));
  const { values: got, log } = await values(bad);
  expect(got).toEqual(defaults);
  expect(log).toContain(
    `Invalid value not a number for MAX_REACTOR_CALL_DEPTH, falling back to ${defaults.MAX_REACTOR_CALL_DEPTH}.`,
  );
}, 30_000);

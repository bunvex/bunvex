// STUDY-147: every knob the engine reads, under Convex's name (the server's are in the server's
// knobs-env.test.ts). A process with each one set reads it; with each one set to something that does not parse,
// it keeps the defaults and starts, as Convex's `env_config`.
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
  WRITE_LOG_MIN_RETENTION_SECS: "21",
  WRITE_LOG_MAX_RETENTION_SECS: "22",
  MAX_TRANSACTION_WINDOW_SECONDS: "24",
  TRANSACTION_MAX_NUM_USER_WRITES: "11",
  TRANSACTION_MAX_USER_WRITE_SIZE_BYTES: "12",
  TRANSACTION_MAX_READ_SIZE_ROWS: "13",
  TRANSACTION_MAX_READ_SIZE_BYTES: "14",
  TRANSACTION_MAX_READ_SET_INTERVALS: "15",
  TRANSACTION_MAX_NUM_SCHEDULED: "16",
  TRANSACTION_MAX_SCHEDULED_TOTAL_ARGUMENT_SIZE_BYTES: "17",
  UDF_EXECUTOR_OCC_MAX_RETRIES: "18",
  UDF_EXECUTOR_OCC_INITIAL_BACKOFF_MS: "19",
  UDF_EXECUTOR_OCC_MAX_BACKOFF_MS: "20",
  WRITE_LOG_SOFT_MAX_SIZE_BYTES: "23",
  INITIAL_PERSISTENCE_WRITES_BACKOFF_MS: "25",
  MAX_PERSISTENCE_WRITES_BACKOFF_MS: "26",
  MAX_REPEATABLE_TIMESTAMP_COMMIT_DELAY: "27",
  MAX_REPEATABLE_TIMESTAMP_IDLE_FREQUENCY: "28",
  COMMITTER_MAX_WRITE_BATCH_DOCUMENTS: "29",
  COMMITTER_MAX_WRITE_BATCH_BYTES: "30",
  INDEX_BACKFILL_CHUNK_SIZE: "31",
  INDEX_BACKFILL_CHUNK_RATE: "32",
  INDEX_BACKFILL_READ_SIZE: "33",
  INDEX_BACKFILL_PROGRESS_INTERVAL_SECONDS: "34",
  INDEX_BACKFILL_CONCURRENCY: "35",
  INDEX_WORKERS_INITIAL_BACKOFF: "36",
  INDEX_WORKERS_MAX_BACKOFF: "37",
  SYSTEM_TABLE_CLEANUP_CHUNK_SIZE: "38",
  SYSTEM_TABLE_CLEANUP_ROWS_PER_SECOND: "39",
  ENV_VAR_LIMIT: "40",
  ENV_VAR_TOTAL_SIZE_LIMIT: "41",
  MYSQL_MAX_CHUNK_BYTES: "42",
  DATABASE_WORKERS_POLL_INTERVAL: "43",
  SEARCH_INDEX_SIZE_SOFT_LIMIT: "44",
  MIN_COMPACTION_SEGMENTS: "45",
  MAX_SEGMENT_DELETED_PERCENTAGE: "0.5",
};

test("each knob is read from the environment under Convex's name", async () => {
  const defaults = (await values({})).values;
  const { values: set, log } = await values(SET);
  expect(Object.keys(set).sort()).toEqual(Object.keys(SET).sort());
  for (const [k, v] of Object.entries(SET)) {
    expect([k, defaults[k]]).not.toEqual([k, Number(v)]);
    expect([k, set[k]]).toEqual([k, Number(v)]);
  }
  expect(log).toContain("Overriding TRANSACTION_MAX_READ_SIZE_ROWS to 13 from environment");
}, 30_000);

test("a value that does not parse keeps the default, logged, and nothing fails", async () => {
  const defaults = (await values({})).values;
  const bad = Object.fromEntries(Object.keys(SET).map((k) => [k, "not a number"]));
  const { values: got, log } = await values(bad);
  expect(got).toEqual(defaults);
  expect(log).toContain(
    `Invalid value not a number for TRANSACTION_MAX_READ_SIZE_ROWS, falling back to ${defaults.TRANSACTION_MAX_READ_SIZE_ROWS}.`,
  );
}, 30_000);

// Retention of `_session_requests` (STUDY-23 P6).
import { expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, SESSION_REQUEST_RETENTION_MS } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { cleanSessionRequests, sessionRetentionFromEnv } from "../src/session-cleanup.ts";

async function engineWith(n: number) {
  const engine = await new Engine(
    defineSchema({ t: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  for (let i = 0; i < n; i++)
    await engine.sessionMutation(
      (db) => db.insert("t", { i }),
      "m:insert",
      { sessionId: "s", requestId: i },
      () => ({ result: "null", logLines: [] }),
    );
  return engine;
}

const replays = async (engine: Engine, n: number) => {
  let replayed = 0;
  for (let i = 0; i < n; i++) {
    const r = await engine.sessionMutation(
      (db) => db.insert("t", { again: i }),
      "m:insert",
      { sessionId: "s", requestId: i },
      () => ({ result: "null", logLines: [] }),
    );
    if ("replayed" in r) replayed++;
  }
  return replayed;
};

test("records older than the window are deleted in chunks of 64, rate-limited; newer ones stay", async () => {
  const engine = await engineWith(150);
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  // Now: every record is younger than two weeks, nothing goes.
  expect(await cleanSessionRequests(engine, SESSION_REQUEST_RETENTION_MS, { sleep })).toBe(0);
  expect(await replays(engine, 150)).toBe(150);
  // Three weeks later, all of them are older than the window.
  const later = () => Date.now() + 21 * 24 * 60 * 60 * 1000;
  expect(await cleanSessionRequests(engine, SESSION_REQUEST_RETENTION_MS, { now: later, sleep })).toBe(150);
  // 64 + 64 + 22: a pause of 64/256 s after each full chunk.
  expect(sleeps).toEqual([250, 250]);
  // A resend that old runs again, as in Convex once its record is gone.
  expect(await replays(engine, 3)).toBe(0);
});

test("the window comes from MAX_SESSION_CLEANUP_DURATION_HOURS; 0 keeps records", () => {
  expect(sessionRetentionFromEnv({})).toBe(SESSION_REQUEST_RETENTION_MS);
  expect(sessionRetentionFromEnv({ MAX_SESSION_CLEANUP_DURATION_HOURS: "1" })).toBe(3_600_000);
  expect(sessionRetentionFromEnv({ MAX_SESSION_CLEANUP_DURATION_HOURS: "0" })).toBeNull();
  expect(() => sessionRetentionFromEnv({ MAX_SESSION_CLEANUP_DURATION_HOURS: "x" })).toThrow("not a number");
});

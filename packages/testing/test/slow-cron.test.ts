// A cron whose run takes real time (an action waiting for a service): `finishAllScheduledFunctions` waits for it
// before moving the clock on, so every run due on the way runs. Under the function sandbox every run is a round trip
// to a child process, the same case.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "../src/index.ts";

const APP = join(import.meta.dir, "fixtures", "slow-cron");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});

test("finishAllScheduledFunctions waits for a cron's run in progress before moving the clock", async () => {
  const slow = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async () => {
      await Bun.sleep(50);
      return new Response("ok");
    },
  });
  try {
    const t = bunvexTest({ cwd: APP, env: { SLOW_URL: `http://127.0.0.1:${slow.port}/` } });
    open.push(t);
    // A job three hours away: the hourly cron runs at once, then at each hour on the way.
    await t.mutation(anyApi.slow.later, { delayMs: 3 * 3600_000 });
    await t.finishAllScheduledFunctions();
    expect(await t.query(anyApi.slow.ticks)).toBe(4);
  } finally {
    slow.stop(true);
  }
}, 30_000);

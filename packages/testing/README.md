# @bunvex/testing

Test bunvex functions against the real engine, in the test's own process ([STUDY-159](../../docs/study/STUDY-159-testing.md)).
It keeps convex-test's API, renamed: `convexTest` is `bunvexTest`.

```ts
import { expect, test } from "bun:test";
import { bunvexTest } from "@bunvex/testing";
import { api, internal } from "../bunvex/_generated/api";

test("sending a message", async () => {
  const t = bunvexTest(); // the project in the working directory, pushed as `bunvex deploy` pushes it
  await t.withIdentity({ name: "Ada" }).mutation(api.messages.send, { body: "hi" });
  expect(await t.query(api.messages.list)).toEqual(["Ada: hi"]);
  await t.mutation(api.messages.sendLater, { body: "later", delayMs: 60_000 });
  await t.finishAllScheduledFunctions(); // moves the test's virtual clock to each job
  await t.close();
});
```

- **Each `bunvexTest()` is a deployment of its own**: an engine on memory persistence and a virtual clock, with the
  app's functions, schema, HTTP actions and components installed as a push installs them.
- **It behaves as a deployment**, not as convex-test's mock: write conflicts and retries, Convex's limits, real ids and
  storage URLs, deterministic `Date` and `Math.random` in queries and mutations.
- **Env**: functions see `bunvexTest({ env: { … } })`, not the test's `process.env`.
- **Time**: scheduled functions and crons run on the test's virtual clock as `finishAllScheduledFunctions()` moves
  it; `t.runCron(name)` runs a cron now.
- **Callers**: `withIdentity({ … })` and `withRequestMetadata({ ip, userAgent })`; `t.fetch(path)` calls the app's
  HTTP actions as that user.
- **Options**: `cwd`, the project's directory (default: the working directory).
- **Runner**: `bun test` (Vitest only under Bun: `bunx --bun vitest`).

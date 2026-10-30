# @bunvex/testing

Test bunvex functions against the real engine, in the test's own process.
It keeps convex-test's API, renamed: `convexTest` is `bunvexTest`.

```ts
import { expect, test } from "bun:test";
import { bunvexTest } from "@bunvex/testing"; // or "@bunvex/testing"
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
- **It behaves as a deployment**, not as convex-test's mock: write conflicts and retries, a deployment's limits, real ids and
  storage URLs, deterministic `Date` and `Math.random` in queries and mutations.
- **Env**: functions see `bunvexTest({ env: { … } })`, not the test's `process.env`.
- **Time**: scheduled functions and crons run on the test's virtual clock as `finishAllScheduledFunctions()` moves
  it; `t.runCron(name)` runs a cron now. The write limit (4 MiB a second, as a deployment's) counts on that clock
  too: a test that seeds more than that moves the clock between batches (`t.advanceTime(1000)`).
- **Callers**: `withIdentity({ … })` and `withRequestMetadata({ ip, userAgent })`; `t.fetch(path)` calls the app's
  HTTP actions as that user.
- **Components**: an app's are installed as its push installs them; call one directly through
  `componentsGeneric().<name>`. A component package's own tests mount it with
  `t.registerComponent(name, "path/to/its/dir")`, which returns its reference.
- **Options**: `cwd`, the project's directory (default: the working directory).
- **Runner**: `bun test` (Vitest only under Bun: `bunx --bun vitest`).

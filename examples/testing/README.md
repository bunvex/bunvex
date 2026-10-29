# Testing: the app's functions, in a test

`test/functions.test.ts` tests this app's functions with `@bunvex/testing` (`@bunvex/testing`). Each test gets a deployment of its own,
inside the test's process: the real engine, on memory and a virtual clock, with `bunvex/` pushed as
`bunvex deploy` pushes it. There is no front end and nothing to start.

```sh
bun install
bun test
```

What the tests show (the scenarios of Convex's `convex-test` demo, written for bunvex):

- `t.query`, `t.mutation`, `t.action` by reference, internal functions included (`posts`);
- `t.withIdentity({ name })` for signed-in users (`tasks`);
- `t.run(ctx => …)` to set up or read data directly;
- an error the app throws, as the test sees it (`messages.send`);
- scheduled functions on the test's clock: `t.advanceTime(ms)` and `t.finishAllScheduledFunctions()`
  (`scheduler`);
- `t.fetch` to the HTTP actions, anonymous or as a user (`http.ts`);
- an action calling another service (`messages.ask`): the app's code runs in its own context, as on a deployment,
  so a test does not replace `fetch`. It serves a stand-in and passes its address in the deployment's env,
  `bunvexTest({ env })`.

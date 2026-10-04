# Scheduling: self-destructing messages

`bunvex/messages.ts` posts a message that counts down and deletes itself. `sendExpiring` inserts it and
schedules `tick` with `ctx.scheduler.runAfter`; each `tick` rewrites the countdown and schedules the next one,
until the last deletes the message. `tick` is an `internalMutation`: only the scheduler (or other functions)
can run it. The page (`src/App.tsx`) only renders `useQuery(api.messages.list)`, and every step shows up live.

```sh
bun install
bun run dev   # starts a local deployment, pushes the functions, opens the page
```

Its end-to-end test (`test/e2e.test.ts`) deploys it to a fresh backend and follows a countdown through a
subscription.

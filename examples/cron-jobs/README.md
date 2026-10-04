# Cron jobs: a chat that clears itself

`bunvex/crons.ts` defines a cron job with `cronJobs()`: every 10 seconds it runs the internal mutation
`messages.clearAll`, which deletes every message. Nobody calls it: the deployment runs it on schedule, and
the page (`src/App.tsx`), subscribed with `useQuery(api.messages.list)`, empties itself.

```sh
bun install
bun run dev   # starts a local deployment, pushes the functions (crons included), opens the page
```

Intervals take `{ seconds }`, `{ minutes }` or `{ hours }`; `crons.cron(name, "0 * * * *", …)` takes a cron
string, and `crons.daily`, `weekly`, `monthly` and `hourly` exist too.

Its end-to-end test (`test/e2e.test.ts`) deploys it to a fresh backend and waits for the cron to clear a
message.

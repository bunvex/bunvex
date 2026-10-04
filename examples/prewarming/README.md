# Prewarming

`client.prewarmQuery({ query, args })` subscribes to a query before the view that needs it renders; the
subscription lasts `extendSubscriptionFor` milliseconds (5 seconds by default), long enough for the view to
take over. Here, hovering "Open the chat" prewarms `messages.list`, so a click shows the messages at once
instead of "Loading…".

```sh
bun install
bun run dev
```

Its end-to-end test (`test/e2e.test.ts`) checks, through a `BunvexReactClient`, that a prewarmed result is in
the client and live before anything reads it, and that the subscription ends after `extendSubscriptionFor`.

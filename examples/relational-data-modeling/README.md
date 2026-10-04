# Relational data modeling: channels

Documents that reference each other. A message holds its channel's id (`v.id("channels")` in
`bunvex/schema.ts`), and the `by_channel` index reads one channel's messages without scanning the rest.
`messages.list` joins the channel's name in with `ctx.db.get`. The page lists the channels and shows the
selected one's messages, live.

```sh
bun install
bun run dev
```

Its end-to-end test (`test/e2e.test.ts`) checks that each channel's live list holds only its own messages,
and that an id of another table is refused as a channel.

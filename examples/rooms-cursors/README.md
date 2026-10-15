# Rooms and cursors

Live cursors and a wave in a room, and who is online in a presence scope: state that changes many times a second
and matters for a few seconds, held in the server's memory beside the database and never in it.

- `bunvex/rooms.ts` defines a `room` (`board`: each member's presence is its cursor; `wave` is an event) and a
  `presence` scope (`online`: one entry per signed-in user).
- `src/App.tsx` joins them with `useRoom` (`useOthers`, `useMyPresence`, `useBroadcast`, `useEvent`) and
  `usePresence`.

```sh
bun install
bun run dev   # starts a local deployment, pushes the functions, opens the page
```

Open the page in two windows: each sees the other's cursor move, and a wave in one shows in the other. A room needs
no sign-in. The "online" line is a presence scope, which lists signed-in users: without a sign-in the page shows
the server's refusal. Add an auth configuration (see the `users-and-clerk` example) and it counts users, one per
user however many tabs are open.

Nothing here is stored: a restart of the backend drops every room, and a member who closes the page leaves 5
seconds later. [docs/rooms.md](../../docs/rooms.md) has the API and the limits.

Its end-to-end test (`test/e2e.test.ts`) checks the same through the client; the browser test
(`examples/_browser/rooms-cursors.browser.ts`) drives two pages.

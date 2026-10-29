# Rooms and presence scopes

Some state changes many times a second, matters for a few seconds and is worthless once the connection that made it
is gone: where a cursor is, who is typing, a reaction that flies across the screen. Kept in tables, each change is a
mutation: a transaction, a write to the log and an invalidation of every subscription that reads the table. Rooms
keep that state **in the server's memory, beside the database and never in it**.

Rooms are a bunvex addition ([AD-42](parity/additions.md); Convex has nothing like them, and its presence component
keeps its state in tables). They are opt-in: an app that does not define a room, and a client that does not join
one, see no difference from Convex. The reasoning, and what Convex and its peers do, is in
[STUDY-164](study/STUDY-164-ephemeral-rooms.md); an app to start from is [examples/rooms-cursors](../examples/rooms-cursors).

> [!WARNING]
> **A restart drops every room.** Nothing here is stored. Restart the backend and every member is gone; clients
> reconnect and join again, so a room fills up again from what they say next. Never put state in a room that has to
> survive: that belongs in a table.

## 1. A room or a presence scope

| | `room` | `presence` (a scope) |
|---|---|---|
| A member is | a connection: three tabs are three members | a signed-in user: three tabs are one member, present while any of them is |
| Carries | each member's presence (a snapshot, replaced whole on every update) and events | each user's state, and whether the user is idle |
| For | cursors, selections, typing, reactions | who is online in a channel, a facepile |
| Anonymous connections | may join, if the gate allows | refused: a scope lists users |
| Fast updates | yes (up to 40/s per member) | no, it changes rarely |

A room and a scope may share their arguments (a document's cursors and its "who is here"); each is defined, and gated,
on its own.

Rooms are not an in-memory database. A query or a mutation never reads who is in a room (it would stop being a
function of the database); only an action does (section 4).

## 2. Defining them

A room is defined in the functions directory, like a function, with `room` and `presence` from `_generated/server`.
Each field is a validator object (or a `v.object(...)`); the generated `api` has a reference to it.

```ts
// bunvex/rooms.ts
import { v } from "@bunvex/values";
import { presence, room } from "./_generated/server";

export const doc = room({
  args: { docId: v.id("docs") },
  // Who may join. Runs at join with a query's ctx, so it may read the database. Absent: everyone.
  canJoin: async (ctx, { docId }) => {
    const user = await ctx.auth.getUserIdentity();
    const doc = await ctx.db.get(docId);
    return user !== null && doc !== null && doc.members.includes(user.subject);
  },
  // Who may publish presence and events. False: a spectator, who sees but does not send. Absent: every member.
  canPublish: async (ctx, { docId }) => true,
  // Each member's snapshot: every update replaces it whole.
  presence: { x: v.number(), y: v.number(), typing: v.optional(v.boolean()) },
  // Fire-and-forget events, each with the validator of its payload.
  events: { reaction: { emoji: v.string() } },
});

export const online = presence({
  args: { channel: v.id("channels") },
  canJoin: async (ctx, { channel }) => (await ctx.db.get(channel)) !== null,
  state: { name: v.string(), status: v.optional(v.string()) },
});
```

- **Gates** (`canJoin`, `canPublish`) run at join, and again when the connection's identity changes (a new token,
  a refresh included); never reactively mid-session, and not on a push: a member keeps the definition it joined
  with. A gate must return exactly `true` to allow; anything else (false, a truthy object) refuses. A gate that
  refuses, throws or fails answers the same thing, "You cannot join this room.": what it said or threw stays on the
  server. On an identity change that is final for the room: a gate that fails transiently during a token refresh
  ends the membership too (the client sees it, below).
- **Validation.** Join arguments, presence, state and event payloads are checked against their validators; an
  invalid one is a `validation` error, not delivered.
- A scope's `canJoin` is optional, and whatever it says, an anonymous connection cannot join a scope.

## 3. In the app

### React

```tsx
import { usePresence, useRoom } from "@bunvex/react";
import { api } from "../bunvex/_generated/api";

function Cursors({ docId }) {
  const room = useRoom(api.rooms.doc, { docId });   // args "skip" joins nothing (status stays "joining")
  const others = room.useOthers();                  // [{ memberId, userId, presence }], not you
  const [mine, setMine] = room.useMyPresence();     // setMine is throttled for you
  const react = room.useBroadcast("reaction");      // react({ emoji: "👋" })
  room.useEvent("reaction", (from, data) => {});    // from: the sender's member id, null from the server
  // room.status: "joining" | "joined" | "error"; room.error: { code, message } | null
}

function Facepile({ channel }) {
  const { others, count, me, setMyState, isIdle, status, error } = usePresence(
    api.rooms.online,
    { channel },
    { idleMs: 60_000 }, // optional: idle after a minute without pointer or key input
  );
  // others: [{ userId, state, idle }], one per user, you left out; count includes you
}
```

`useOthers`, `useMyPresence`, `useBroadcast` and `useEvent` are hooks: call them at the top level of a component, the
same ones in the same order on every render. Each is a subscription of its own, so a component that only listens for
reactions does not re-render when a cursor moves. A room is left when the component unmounts or the arguments change
(StrictMode's double effect is one member). `me` and `useMyPresence` follow your own presence, shared by every
component that joined the same room.

### Without React

```ts
const room = client.joinRoom(api.rooms.doc, { docId });
room.subscribe(() => render(room.others()));
room.setPresence({ x: 10, y: 20 });
room.broadcast("reaction", { emoji: "👋" });
const off = room.on("reaction", (from, data) => {});
room.leave();
```

`client.joinPresence(ref, args)` gives `others()`, `count()`, `myState()`, `setState(s)`, `setIdle(idle)`,
`subscribe(cb)` and `leave()`. Joins of the same room and arguments share one membership, ended by the last
`leave()`. Rooms are joined again on every reconnect, and a room refused or ended is joined again after every new
token (`setAuth`, a refresh, `clearAuth`): a scope joined before sign-in joins once the user is signed in. A scope's
idle is per handle: the user is idle when every handle that called `setIdle` says so, and a handle's `leave()` takes
its idle with it.

### From the server

- **A mutation broadcasts after it commits**: `await ctx.rooms.broadcast(api.rooms.doc, { docId }, "reaction", data)`.
  Nothing is sent if the mutation fails or is retried (an OCC retry sends once, for the attempt that committed), as
  scheduling a function works. The event's `from` is null. It is sent at the commit, so it may reach a client before
  the query update that carries the mutation's write.
- **An action broadcasts at once**, and may read members (section 4).
- A scope has no events, so no broadcast.

## 4. Reading who is here: actions only

```ts
export const count = action({
  handler: async (ctx) => {
    const members = await ctx.rooms.members(api.rooms.doc, { docId }); // [{ memberId, userId, presence }]
    const users = await ctx.presence.list(api.rooms.online, { channel }); // [{ userId, state, idle }]
  },
});
```

Queries and mutations have neither: their result must be a function of the database. Both are a snapshot of this
process, taken when the action asks.

## 5. What members see

- **Not your own.** A member's `others()` leave it out, and its own events do not come back to it.
- **A late joiner** gets the members and their presence now, and no past events.
- **Reconnect grace.** A member whose socket drops is kept for **5 seconds**. A client that comes back within it
  (the same session) keeps its member, its presence and its rooms, and the others see no leave and no join. After it,
  they see a leave, and the client joins as a new member. A reconnect with another identity ends the kept member.
- **A scope member's tabs.** Another tab of the same user joining or leaving changes nothing the others see, unless
  that changes the user's idle (a user is idle when all their tabs are).
- **Throttling.** The client sends presence at most every 50 ms (the first update at once, the last one after the
  gap). The server keeps each member's latest presence and sends one frame to the room per tick (30 ms), so the cost
  grows with members times ticks, not updates times members.
- **Errors.** A refused join is an `error` status with a code: `no_access` (a gate said no, or a scope without a
  signed-in user), `validation`, `limit` or `not_found`. On a joined room, `forbidden` (publishing without
  `canPublish`), `rate_limited` and an invalid payload are warnings in the console; the status stays `joined`. A
  room or scope in `error` sends nothing more.
- **Ended by the server.** When a new identity is refused by a joined room's gates (or its rejoin as the new user is
  over a cap), the server sends `RoomLeft`: the handle becomes `error` with that code (`no_access` or `limit`), its
  others are emptied, and it is joined again only after the next token.

## 6. Limits

Every limit is a knob (an environment variable of the backend). Excess presence updates and events are dropped, with
one warning per second per connection. Membership frames are never dropped: a client too far behind (its socket
holds more than `ROOM_MAX_BUFFERED_BYTES`) is disconnected and syncs again when it reconnects.

| Variable | Default | What it limits |
|---|---|---|
| `ROOM_PAYLOAD_MAX_BYTES` | 4096 | A presence, a state or an event payload, as JSON (also a server broadcast) |
| `ROOM_ARGS_MAX_BYTES` | 4096 | A room's join arguments, as JSON |
| `ROOMS_PER_CONNECTION` | 64 | Rooms and scopes one connection is in |
| `ROOM_PRESENCE_PER_SECOND` | 40 | Presence updates per member |
| `ROOM_EVENTS_PER_SECOND` | 10 | Events per member |
| `ROOM_MEMBER_CAP` | 500 | Members of one room (fan-out grows with its square) |
| `ROOM_RECONNECT_GRACE_SECS` | 5 | How long a dropped member is kept |
| `ROOM_TICK_MS` | 30 | The server's coalescing tick |
| `ROOM_MAX_BUFFERED_BYTES` | 1048576 | A slow client's queue before it is disconnected |

## 7. Not in v1

- **One process.** The state is the process's memory. When followers exist, rooms relay through the leader
  ([STUDY-164](study/STUDY-164-ephemeral-rooms.md) §3.7).
- **No `onJoin` / `onLeave` hooks.** An app that wants "last seen" writes it from the client or a mutation.
- **No room state** (a shared document, a CRDT). Presence and events only.

The cost against the same cursors kept in a table is measured in [STUDY-164](study/STUDY-164-ephemeral-rooms.md) §7
(`bun bench/rooms.ts`).

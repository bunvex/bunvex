# STUDY-164 — Ephemeral state: rooms, presence and broadcast (an addition)
<!-- index: Ephemeral state: rooms with presence and broadcast held in memory beside the database (Convex keeps it in tables; its presence component, its peers, minivex's lessons) | built (v1): AD-42 (two concepts, relay through the leader) -->

- **Status:** built (v1) — AD-42 accepted by the owner on 2026-10-15 (§6): rooms and presence scopes, two concepts
  (R2); relay through the leader when followers exist, a bus such as Redis measured then (R5); the rest as proposed.
  What was built, the rulings made on the way and the measurement are in §7. User docs: [docs/rooms.md](../rooms.md)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend (2026-09-28); `@convex-dev/presence`
  at `a7640e7e` (v0.4.0) and `9d69fc93` (v0.3.2)
- **Related:** [STUDY-23](STUDY-23-sync-protocol-v1.md) (protocol v1, sessions),
  [STUDY-24](STUDY-24-horizontal-scaling.md) (leader + followers, DV-113/DV-114),
  [STUDY-152](STUDY-152-components-restudy.md) (components, which Convex's presence needs),
  [STUDY-90](STUDY-90-examples.md) (`presence-facepile`, `presence-typing-indicator`); the owner's earlier minivex
  rooms (`~/sandbox/minivex`, not a reference for behaviour, only for lessons)

Some state changes many times a second, matters for a few seconds and is worthless once the connection that made
it is gone: who is in a document, where their cursor is, who is typing, a reaction that flies across the screen.
On Convex an app keeps that state in tables, so every cursor move is a mutation: a transaction, a write to the log,
OCC and an invalidation of every subscription that reads the table. This study looks at how Convex and its peers
handle that state, and proposes **rooms** — presence and broadcast held in memory, beside the database, never in
it — as a bunvex addition.

## 1. How Convex does it

### 1.1 The backend has no ephemeral primitive

Nothing in `crates/` keeps per-connection state for apps or relays messages between clients. The sync protocol's only
client-to-server message besides queries, mutations, actions and authentication is `Event`, and it is **telemetry**:
the client sends `ClientConnect` with performance marks (`npm-packages/convex/src/browser/sync/client.ts:1088`) and
`NetworkRecoveryReconnect` (`web_socket_manager.ts:417`, `:932`); the backend parses it into `TypedClientEvent` for
metrics only (`crates/sync/src/metrics.rs:465-488`). bunvex accepts and drops it (`packages/server/src/sync.ts:1297`,
STUDY-23 P11). No app code ever sees a client message that is not a function call.

### 1.2 Presence is a component over tables

`@convex-dev/presence` (v0.4.0, 2026-07-21; [source](https://github.com/get-convex/presence)) makes the ephemeral
state durable and arranges the tables so that the hot writes never invalidate a subscription:

- **Tables** (`src/component/schema.ts`): `presence {roomId, userId, online, lastDisconnected, data?}` — one row per
  user per room; `sessions {roomId, userId, sessionId, deadline?}` — one row per tab (per hook instance);
  `roomTokens` and `sessionTokens`.
- **Heartbeat** (`src/component/public.ts:26-111`): a mutation every `interval` (10 s by default) that moves the
  session's `deadline` to `now + 2.5 × interval` and flips `presence.online` only when the user was offline. It returns
  a room token and a session token.
- **Expiry:** up to v0.3.2 each heartbeat cancelled and rescheduled one scheduled function per session; v0.4.0
  replaced that with one deployment-wide batch worker that sleeps until the earliest deadline and deletes expired
  sessions 64 at a time, setting `online: false` when a user's last session goes (`public.ts:113-181`, `:459-483`;
  CHANGELOG 0.4.0).
- **The list query** (`public.ts:183-234`) reads `roomTokens` and `presence` only, never `sessions` — the one table a
  heartbeat writes — so subscribers are invalidated on join, leave and `data` changes, not on heartbeats. The room
  token stands in for auth so that every member's subscription has the same arguments and shares one cached result
  (README: "avoid adding per-user reads so all subscriptions can share same cache").
- **Client:** `usePresence(api, roomId, userId, interval = 10000)` returns the room's users, the caller first; it
  stops heartbeating on a hidden tab and sends `disconnect` with `navigator.sendBeacon` on unload (which is why
  `disconnect` cannot check auth). Offline after 25 s by default; lists capped at 104.

Cursors are a harder case. The third-party "Multiplayer Cursors" component listed on convex.dev
([Iann29/convex-multiplayer-cursors](https://github.com/Iann29/convex-multiplayer-cursors)) follows the same rule —
"hot data where nobody subscribes, cold data where everyone subscribes" — and batches: a client flushes at most every
200 ms one document holding its last samples, and the other clients replay them with 260 ms of interpolation. A
cursor is a durable write five times a second per user.

### 1.3 What Convex has said

- Ian Macartney's [Implementing Presence with Convex](https://stack.convex.dev/presence-with-convex) (≈2022) places
  presence between application state and session state, which "is ephemeral and can be held in memory & quickly
  discarded", and says: "Sharing mouse cursor positions are the point at which I'd recommend using a dedicated
  in-memory service, rather than trying to persist that data to a database."
- No statement was found that Convex plans a first-class ephemeral, presence or broadcast feature: not in the
  backend (`4577b9031`), the client, their issues, the posts by Jamie Turner and James Cowling that a search reaches
  (Feb 2026 "Convex v2 brewing", with no details), or the August 2026 Series B coverage (centred on components).
  Discord threads (2023) reached only through search snippets mention the team discussing connect and disconnect
  events for the server, not started. The owner remembers a post saying it is planned; if found, cite it here.

## 2. What an app can observe

- **On Convex:** presence and cursors are tables (or the presence component's tables). Every update is a mutation:
  it counts against function calls, write bandwidth and OCC; it is durable, readable by any query, and costs a
  subscription update per member. "Who is here" lags by up to 25 s after a tab dies.
- **On bunvex today:** the same, for an app that keeps presence in its own tables (Convex's `presence-facepile`
  demo runs as is). The presence component needs components (DV-55, STUDY-152), not built yet.
- **The addition must not change any of that.** A Convex app that does not use rooms behaves the same; Convex's
  client never sends the new messages, and bunvex never sends them to a client that did not join a room.

## 3. How bunvex would do it (proposal)

### 3.1 Three kinds of ephemeral state, and which ones v1 covers

| Kind | Example | State kept | v1 |
|---|---|---|---|
| **Presence** | who is here, cursor, selection, "typing" | one snapshot per member, gone when the member leaves | yes |
| **Events** (broadcast) | a reaction, "Ana clicked", "refresh your view" | none; whoever joins later sees nothing | yes |
| **Room state** | a live CRDT document, a game's board | the room's, in memory | no — later, if ever (R8) |

Every peer that is good at cursors splits it this way: Liveblocks (presence, broadcast events, storage), Supabase
Realtime (Presence, Broadcast — and its docs say not to put cursors in Presence), Phoenix (Presence over PubSub),
PartyKit / Durable Objects (an actor per room). None of them makes the ephemeral state queryable like a database.

### 3.2 Not an in-memory database

The tempting design is a second, in-memory table space that queries read and mutations write. It is rejected here:

- a reactive query that reads ephemeral state returns a result that a restart silently changes, so a query is no
  longer a function of the database at a timestamp (the property every cache, journal and pagination cursor in
  bunvex rests on);
- OCC, retries and the commit log make no sense for a cursor, and are exactly the cost being avoided;
- it would make every follower (STUDY-24) replicate state that no store holds.

Rooms are a separate channel on the same WebSocket. The bridges to the database are narrow and explicit (§3.4).

### 3.3 The API

A room is defined in the functions directory like a function, gets an `api` reference from codegen, and is gated
like one:

```ts
// bunvex/rooms.ts
import { v } from "bunvex/values";
import { room } from "./_generated/server";

export const doc = room({
  args: { docId: v.id("docs") },
  // Who may see the room. Runs once at join, with a query's ctx: it may read the database.
  canJoin: async (ctx, { docId }) => {
    const user = await ctx.auth.getUserIdentity();
    const doc = await ctx.db.get(docId);
    return user !== null && doc !== null && doc.members.includes(user.subject);
  },
  // Who may publish (presence and events). Absent: everyone who joined. False: a spectator.
  canPublish: async (ctx, { docId }) => true,
  // Each member's snapshot: every update replaces it whole.
  presence: v.object({
    cursor: v.optional(v.object({ x: v.number(), y: v.number() })),
    typing: v.optional(v.boolean()),
  }),
  // Fire-and-forget events, each with its payload's validator.
  events: { reaction: v.object({ emoji: v.string() }) },
});
```

```tsx
// React
const room = useRoom(api.rooms.doc, { docId });
const others = room.useOthers();                 // [{ memberId, userId, presence }], not you
const [mine, setMine] = room.useMyPresence();    // setMine is throttled for you
const react = room.useBroadcast("reaction");     // react({ emoji: "👋" })
room.useEvent("reaction", (from, data) => ...);  // listen
```

Sub-hooks rather than one value, as minivex and Liveblocks do: a component that renders cursors re-renders when a
cursor moves, one that only listens for reactions does not. A non-React client gets the same through
`client.joinRoom(ref, args)` returning an object with `others()`, `setPresence()`, `broadcast()`, `on()` and
`leave()`.

**A presence scope is the second concept (R2, the owner's choice).** A room's members are connections: three tabs are
three cursors. "Who is online in this channel" wants users: three tabs are one person, and a person with no cursor
still counts. That is its own definition, as minivex's `definePresence`, and the closest thing to what Convex's
presence component gives (`usePresence` returning the room's users, §1.2):

```ts
// bunvex/presence.ts
import { v } from "bunvex/values";
import { presence } from "./_generated/server";

export const online = presence({
  args: { channel: v.id("channels") },
  // Signed-in users only: a scope lists users, so an anonymous connection can neither join nor see it.
  canJoin: async (ctx, { channel }) => {
    const user = await ctx.auth.getUserIdentity();
    const c = await ctx.db.get(channel);
    return user !== null && c !== null && (c.public || c.members.includes(user.subject));
  },
  // Each user's state; any of the user's tabs may set it, the last write wins for the user.
  state: v.object({ name: v.string(), status: v.optional(v.string()) }),
});
```

```tsx
const { others, count, me, setMyState } = usePresence(api.presence.online, { channel });
// others: [{ userId, state, idle }], one per user, you left out; count includes you
```

- **Per user on the server**, not in the client as minivex did: a user is in the scope while any of their
  connections is (after the grace of §3.5), so `count` is right for every member and a user with ten tabs costs one
  entry in every other member's frames.
- **No events and no cursors:** a scope carries a small state per user and changes rarely. What moves fast belongs in
  a room.
- **Idle:** `usePresence(ref, args, { idleMs })` marks the user idle after that long without input on any of their
  tabs (the server keeps the latest of their tabs' activity); an idle user stays in the list, flagged.
- **One room and one scope can share their args** (a document's cursors and its "who is here"); each is gated on its
  own.

### 3.4 The bridges to the database

- **Gates read the database** (`canJoin`, `canPublish` run with a query's ctx). They run at join and again when the
  connection's identity changes (a new token re-joins every room, as minivex does); not reactively mid-session (R4).
- **Mutations and actions can broadcast:** `ctx.rooms.broadcast(api.rooms.doc, { docId }, "reaction", data)`. From a
  mutation the event is sent **after the commit**, and not at all if the mutation fails or retries — the same rule as
  scheduling. It lets a server tell the members of a room "a new message arrived" without a subscription (R3).
- **Reading presence from server functions** — "how many people are in this document" — is for actions only
  (`ctx.rooms.members(...)` for a room's connections, `ctx.presence.list(...)` for a scope's users), never for queries
  or mutations, which must stay deterministic (R3). A scope has no broadcast: it has no events.
- **No onJoin / onLeave hooks in v1.** An app that wants "last seen" writes it from the client or from a mutation;
  hooks that call a mutation on leave can come later (R7).

### 3.5 Members, reconnects and limits

- **A room's member is a connection**, with the `userId` of its identity (`subject`), or none when anonymous. Three
  tabs are three members. **A scope's member is a user** (§3.3), present while one of their connections is.
- **Reconnect grace.** On Convex's presence a dead tab shows for up to 25 s; on minivex a member leaves at once on a
  dropped socket, so a network blip makes everyone see a leave and a join. Proposed: a member whose socket drops is
  kept for **5 s** (Liveblocks' `lostConnectionTimeout`); a reconnect within that window that resumes the protocol v1
  session (STUDY-23) keeps the same member, its presence and its rooms, with no leave/join seen by the others (R4).
- **Throttling.** The client sends presence at most every 50 ms (leading and trailing edge; Liveblocks: 100 ms). The
  server **coalesces per tick**: it keeps only each member's latest presence and fans out once per tick (≈30 ms), so
  the cost is members × ticks, not updates × members.
- **Limits** (defaults, configurable; R6): presence and event payloads 4 KB each (as JSON), room args 4 KB, 64 rooms
  per connection, 40 presence updates and 10 events per second per member (excess dropped with one warning per
  second), and **a member cap per room** (proposed 500; Liveblocks 10–100, Ably 200, Pusher 100) — fan-out is
  quadratic in the members of a busy room. minivex had no member cap.
- **Backpressure.** Presence frames to a slow client are coalesced, not queued (only the latest per member matters).
  A lost leave would leave a ghost, so membership frames are never dropped: a client too far behind is
  disconnected and re-syncs on reconnect (minivex learned this, `packages/minivex/src/server/ws.ts:820-843`).

### 3.6 The wire

New messages in protocol v1, sent only by bunvex's client and only after `useRoom` / `joinRoom`:

A scope uses the same messages (`kind: "presence"` on `RoomJoin`), its members keyed by user and its `RoomPresence`
carrying the user's state and activity.

- client → server: `RoomJoin {roomId, kind, name, args}`, `RoomLeave {roomId}`, `RoomPresence {roomId, presence}`,
  `RoomEvent {roomId, event, data}`;
- server → client: `RoomSync {roomId, self, canPublish, members}` (the full list at join and after a re-sync),
  `RoomMembers {roomId, set: [...], left: [...]}` (one coalesced frame per tick),
  `RoomEvent {roomId, from, event, data}`,
  `RoomError {roomId, code, message}` (`no_access`, `forbidden`, `validation`, `rate_limited`, `limit`),
  `RoomLeft {roomId, code, message}` (`no_access`, `limit`: the server ended a joined membership on its own, as
  built in §7.1).

They travel beside `Transition` frames, not inside them: room traffic is not part of a query set's version and must
not hold one up.

### 3.7 Where the state lives, and multi-node

- **Today bunvex is one process** (the leader holds the store's lease, PERSIST-01 C7), so every member of a room is
  connected to the same process. The room is a map in memory; it needs no external service and nothing changes for
  self-hosting. A restart drops every room, which is correct: presence that outlives the connection it describes is
  wrong.
- **With followers** (STUDY-24 H1–H2, decided, not built), the members of one room can sit on different followers.
  Options (R5):
  - **A. Relay through the leader.** Followers forward their members' presence and events to the leader, which owns
    the room and fans out to the followers holding members. It reuses the node-to-node links the commit stream
    needs anyway and keeps H4's rule (self-hosting stays bunvex plus its database, no external bus). One hop more of
    latency; the leader's CPU carries the fan-out.
  - **B. Room affinity.** Route a room's members to one node. A connection joins many rooms, so affinity per room
    fights affinity per connection; needs a router in front.
  - **C. A shared bus (Redis or NATS), as minivex did.** minivex's audits show the cost: a snapshot hash per room
    with heartbeats and sweeps, deltas that are lost and repaired, a subscriber that goes deaf, poisoned fields that
    made rooms unjoinable (EPH-1, AUDIT31 F2–F4, EPHEMERAL-02), about 1,000 lines for the Redis side alone. It also
    breaks H4.
  - **Decided: A** (the owner, 2026-10-15); v1 is single-process. When horizontal scaling becomes the focus
    (SCALE-01), the leader's fan-out is measured and the alternatives, a bus such as Redis included, are weighed
    against those numbers then; nothing here rules them out.

### 3.8 Lessons kept from minivex, and what changes

Kept: the definition (`args`, `canJoin` / `canPublish`, a presence snapshot, declared events), sub-hooks, the
per-member rate buckets, insert-before-await on join, closing a client rather than dropping a membership frame, the
canonical room key, and the two concepts (room and presence scope, R2). Changed: a scope's per-user merge is the
server's, not the client's; a reconnect grace (none in
minivex); a member cap; server-side coalescing; broadcast from mutations after commit; no Redis (§3.7); gates
re-run on an identity change. minivex's rooms had about 60 % test coverage in its last audit; bunvex's would be on
the coverage floors from the start.

## 4. Divergences

None. Rooms are opt-in and invisible to an app or a client that does not use them (§2).

| # | Divergence | Why | Decision |
|---|---|---|---|

## 4b. Additions (beyond Convex)

| # | Addition | Why | Decision |
|---|---|---|---|
| R1 | **AD-42 Rooms:** presence and broadcast events in memory beside the database (§3), opt-in through `room()` / `useRoom` and `presence()` / `usePresence` | Convex keeps this state in tables, so every cursor move is a durable transaction and a subscription update per member; Convex's own article recommends an in-memory service for cursors | **accepted** (owner, 2026-10-15) |

## 5. Tests

- **Server, unit:** gates (refused join sends nothing; a spectator cannot publish; a throwing gate is "no access" with
  no internals), validation of presence and events, every limit with its error, the rate buckets, leave on
  disconnect after the grace and not before, re-join on identity change, a broadcast from a mutation that fails or
  retries is never sent, one that commits is sent once.
- **Sync e2e (two and more clients):** a member sees the others' presence and events and not its own; a late joiner
  sees presence and no past events; a reconnect within the grace shows no leave; a reconnect after it shows leave
  and join; three tabs are three room members and one scope member, who leaves the scope only when the last tab
  goes; an anonymous connection is refused by a scope; idle is set and cleared across tabs.
- **Coalescing and backpressure:** 1,000 presence updates in a tick reach a member as one frame; a stalled client is
  disconnected, not grown without bound; memory returns to its baseline after members leave (minivex's EPH-1 kind
  of witness).
- **Performance (a measurement, as CONTRIBUTING asks):** fan-out latency p50/p99 and CPU for rooms of 10, 100 and
  500 members at 20 updates/s each, against the same app keeping cursors in a table on bunvex.
- **Browser:** a cursors demo in Chromium with two pages.
- **Against Convex:** nothing to compare (Convex has no rooms); the differential suite checks that a Convex app's
  behaviour is unchanged.

## 6. Questions and the owner's decisions (2026-10-15)

| # | Question | Proposed | Decided |
|---|---|---|---|
| R1 | Take rooms as an addition (AD-42), v1 = presence + events? | yes | yes |
| R2 | One concept (a room, with `useOthers({ by: "user" })`) or two (room and presence scope, as minivex)? | one | **two**: `room` and `presence` with `usePresence` (§3.3) |
| R3 | Server side: broadcast from mutations (after commit) and actions; read members from actions only? | yes, both | yes |
| R4 | Reconnect grace of 5 s, resuming the member through the protocol v1 session; gates re-run on an identity change, not reactively? | yes | yes |
| R5 | Multi-node, when followers exist: relay through the leader (A), affinity (B) or a bus (C)? | A, with SCALE-01 | A; a bus (Redis) measured when scaling out is the focus |
| R6 | The limits of §3.5, including a member cap per room (500)? | yes | yes |
| R7 | `onJoin` / `onLeave` server hooks: later, not v1? | later | later |
| R8 | Room state (a CRDT document, Yjs) in memory: out of scope for now, studied separately if wanted? | out of scope | out of scope |
| R9 | The name: `room` (Liveblocks, minivex), `channel` (Supabase, Phoenix) or `presence`? | `room` | `room` (and `presence` for scopes) |

## 7. As built (v1)

Built on 2026-10-15 in seven PRs after the plan: #677 (the plan); #678 A (protocol messages, `room()` and
`presence()` definitions); #679 B (`RoomHub`); #680 C (`Tx.afterCommit`); #688 D (sync wiring, `ctx.rooms` and
`ctx.presence`); #694 E (client `joinRoom` / `joinPresence`); #696 F (React hooks); and G, this one: the benchmark,
[docs/rooms.md](../rooms.md), [examples/rooms-cursors](../../examples/rooms-cursors), and the fixes of the
whole-feature review (the `RoomLeft` frame; a re-join after sign-in; room members keyed by session and user; scope
idle per handle; one gate name in the logs; `__proto__` in room args; no sends on a refused room; the room span
names; a lazy `ctx.rooms`). Scope: §3 as decided; no `onJoin` / `onLeave` (R7), no room state (R8), one process (R5).

### 7.1 Rulings made on the way

- **`RoomReference` lives in `@bunvex/protocol`**, so the generated `api` types a room's reference
  (`RoomReference<"room", Args, Presence, Events>`) for the client, React and server alike.
- **One attachment per (connection, room id) and per (connection, room key).** Joining a room a connection is
  already in replaces the attachment. A rejoin within the grace by another user ends the kept member. A scope
  member's leave and rejoin in one tick is one `set`, not a leave and a join; another tab of a scope user joining or
  leaving changes nothing the others see, unless it changes the user's idle (idle is every tab idle).
- **`Tx.afterCommit` (core) carries a mutation's broadcasts.** Measured: no cost on mutations that do not broadcast
  (medians 1,551,187 against 1,550,941 no-op mutations/s, before and after).
- **Gates re-run, concurrently, on an identity change**; a `canPublish` change sends a new `RoomSync`; a refused or
  throwing gate answers "You cannot join this room." and nothing else; server broadcasts obey the 4 KB event limit.
- **The client** rejoins after the auth message, not before it (the plan had it the other way: a defect found in
  review, the gates would have run anonymous); what it sends while the socket is paused goes out on resume; a
  `RoomError` marks a handle as errored only while it is joining (a payload error on a joined room only warns).
- **`RoomLeft`** (added in the final review): when the server ends a joined membership on its own (an identity change
  its gates refuse, or the rejoin as the new user over a cap), it says so, and the client's handle becomes `error`
  with the code, its members cleared and nothing more sent for it. Without it the client showed "joined" with a
  frozen list. A gate that fails transiently during a token refresh evicts the same way (visible now).
- **A new token re-joins on the client too** (§3.4): after every `Authenticate` it sends (sign-in, sign-out, a
  refresh), the client joins again, under a fresh room id, every membership in `error`; a join in flight is retried
  if the refusal for the previous identity comes back. A scope joined before sign-in joins once signed in.
- **A room's member is a session's connection as one user**: two live sockets of one session signed in as two users
  are two members (the old half-open one as the old user), each leaving on its own.
- **A scope's idle is per handle**: the membership is idle when every live handle that reported idle says so, and a
  handle's leave takes its idle with it (a surviving component no longer stays idle after the idle one unmounts).
- **Gates must return exactly `true`**; anything else, a truthy object included, refuses. Members keep the definition
  they joined with across a push (no re-gate on a push). A server broadcast may reach clients before the `Transition`
  that carries the mutation's write (it is sent at the commit, the transition after the subscriptions re-run).
- **`ctx.rooms` is built on first read in a mutation** (and kept lazy for pushed code). Measured: no-op mutations/s on
  a memory engine, 6 interleaved rounds of 50k, median 324,047 eager (f433fce5) against 325,892 lazy (noise).
- **React:** `me` and `useMyPresence` read the shared membership (the client notifies on your own presence), so every
  component of a room follows a `setMyState` made in another.

### 7.2 Measurement: rooms against cursors in a table

`bun bench/rooms.ts` (a script, not a test). N raw sync clients, each moving a cursor 20 times a second for 10 s,
(a) as a room's presence and (b) as one mutation per move into a `cursors` table that every client watches with a
`list` query. The server is its own process (memory engine, no persistence cost, loopback network); latency is the
time from a send to its receipt at another client, over 20 sampled receivers (the others hold their socket and
parse nothing, so the one client process does not become the measurement); CPU is the server's
`process.cpuUsage()` over the send window, as a percentage of one core. 8-core Apple silicon laptop, Bun 1.4.2.

| N | Mode | Moves sent | Samples | p50 (ms) | p99 (ms) | Server CPU (% of a core) |
|---|---|---|---|---|---|---|
| 10 | room | 1,924 | 17,316 | 15.3 | 34.1 | 2 |
| 10 | table | 1,920 | 17,280 | 1.6 | 5.3 | 16 |
| 100 | room | 19,520 | 386,499 | 18.7 | 34.4 | 8 |
| 100 | table | 19,419 | 384,497 | 11.5 | 22.7 | 80 |
| 500 | room | 98,000 | 1,463,068 | 32.4 | 54.7 | 62 |
| 500 | table | 98,562 | 1,083,136 | 4,253 | 8,337 | 137 |

What it says:

- **CPU:** the room costs 8 times less at 10, 10 times less at 100 and 2 times less at 500 (62% against 137%), where the table is past
  what the server can do (its CPU is above one core and its sync queue grows).
- **Latency is not lower at every N.** While the table keeps up (10 and 100 members) its updates arrive sooner than a
  room's: a room waits for the server's 30 ms tick to coalesce, a mutation is sent as soon as it commits. The room's
  p99 stays at 34 ms from 10 to 100 members. At 500 the table falls behind (p50 over 4 s, p99 over 8 s) while the room
  holds p99 54.7 ms: **a room of 500 meets the tick budget (p99 under 100 ms)**, as the cap was chosen for.
- Coalescing is what keeps the room flat: at 500 members 10,000 updates a second reach each member as one frame per
  tick (about 33 a second), not as 10,000 deliveries.
- The 500-member table figures are lower bounds: the run stops recording 4 s after the last send, so receipts later
  than that are not sampled.
- Limits of the measurement: one machine and the loopback; unparsed receivers (a real client parses every frame, which
  at 500 members is about 25 KB per tick); a coalesced update is not a sample in either mode (the table coalesces too
  when its sync queue is behind). The cap was not changed.

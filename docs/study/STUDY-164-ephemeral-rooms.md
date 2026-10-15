# STUDY-164 — Ephemeral state: rooms, presence and broadcast (a proposed addition)

- **Status:** draft — proposes AD-42; questions R1–R9 for the owner (§6)
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
const people = room.useOthers({ by: "user" });   // one entry per user, your other tabs left out
```

Sub-hooks rather than one value, as minivex and Liveblocks do: a component that renders cursors re-renders when a
cursor moves, one that only listens for reactions does not. `useOthers({ by: "user" })` replaces minivex's second
concept (a "presence scope" with its own `usePresence`) with an option on the same room (R2). A non-React client
gets the same through `client.joinRoom(ref, args)` returning an object with `others()`, `setPresence()`,
`broadcast()`, `on()` and `leave()`.

### 3.4 The bridges to the database

- **Gates read the database** (`canJoin`, `canPublish` run with a query's ctx). They run at join and again when the
  connection's identity changes (a new token re-joins every room, as minivex does); not reactively mid-session (R4).
- **Mutations and actions can broadcast:** `ctx.rooms.broadcast(api.rooms.doc, { docId }, "reaction", data)`. From a
  mutation the event is sent **after the commit**, and not at all if the mutation fails or retries — the same rule as
  scheduling. It lets a server tell the members of a room "a new message arrived" without a subscription (R3).
- **Reading presence from server functions** — "how many people are in this document" — is proposed for actions
  only (`ctx.rooms.members(...)`), never for queries or mutations, which must stay deterministic (R3).
- **No onJoin / onLeave hooks in v1.** An app that wants "last seen" writes it from the client or from a mutation;
  hooks that call a mutation on leave can come later (R7).

### 3.5 Members, reconnects and limits

- **A member is a connection**, with the `userId` of its identity (`subject`), or none when anonymous. Three tabs are
  three members; `by: "user"` groups them.
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

- client → server: `RoomJoin {roomId, name, args}`, `RoomLeave {roomId}`, `RoomPresence {roomId, presence}`,
  `RoomEvent {roomId, event, data}`;
- server → client: `RoomSync {roomId, self, canPublish, members}` (the full list at join and after a re-sync),
  `RoomMembers {roomId, set: [...], left: [...]}` (one coalesced frame per tick),
  `RoomEvent {roomId, from, event, data}`,
  `RoomError {roomId, code, message}` (`no_access`, `forbidden`, `validation`, `rate_limited`, `limit`).

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
  - **Recommended: A**, decided with SCALE-01; v1 is single-process.

### 3.8 Lessons kept from minivex, and what changes

Kept: the definition (`args`, `canJoin` / `canPublish`, a presence snapshot, declared events), sub-hooks, the
per-member rate buckets, insert-before-await on join, closing a client rather than dropping a membership frame, the
canonical room key. Changed: one concept instead of room plus presence scope (R2); a reconnect grace (none in
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
| R1 | **AD-42 Rooms:** presence and broadcast events in memory beside the database (§3), opt-in through `room()` and `useRoom` | Convex keeps this state in tables, so every cursor move is a durable transaction and a subscription update per member; Convex's own article recommends an in-memory service for cursors | **proposed** |

## 5. Tests

- **Server, unit:** gates (refused join sends nothing; a spectator cannot publish; a throwing gate is "no access" with
  no internals), validation of presence and events, every limit with its error, the rate buckets, leave on
  disconnect after the grace and not before, re-join on identity change, a broadcast from a mutation that fails or
  retries is never sent, one that commits is sent once.
- **Sync e2e (two and more clients):** a member sees the others' presence and events and not its own; a late joiner
  sees presence and no past events; a reconnect within the grace shows no leave; a reconnect after it shows leave
  and join; three tabs are three members and `by: "user"` gives one.
- **Coalescing and backpressure:** 1,000 presence updates in a tick reach a member as one frame; a stalled client is
  disconnected, not grown without bound; memory returns to its baseline after members leave (minivex's EPH-1 kind
  of witness).
- **Performance (a measurement, as CONTRIBUTING asks):** fan-out latency p50/p99 and CPU for rooms of 10, 100 and
  500 members at 20 updates/s each, against the same app keeping cursors in a table on bunvex.
- **Browser:** a cursors demo in Chromium with two pages.
- **Against Convex:** nothing to compare (Convex has no rooms); the differential suite checks that a Convex app's
  behaviour is unchanged.

## 6. Open questions (for the owner)

| # | Question | Proposed |
|---|---|---|
| R1 | Take rooms as an addition (AD-42), v1 = presence + events? | yes |
| R2 | One concept (a room, with `useOthers({ by: "user" })`) or two (room and presence scope, as minivex)? | one |
| R3 | Server side: broadcast from mutations (after commit) and actions; read members from actions only? | yes, both |
| R4 | Reconnect grace of 5 s, resuming the member through the protocol v1 session; gates re-run on an identity change, not reactively? | yes |
| R5 | Multi-node, when followers exist: relay through the leader (A), affinity (B) or a bus (C)? | A, with SCALE-01 |
| R6 | The limits of §3.5, including a member cap per room (500)? | yes |
| R7 | `onJoin` / `onLeave` server hooks: later, not v1? | later |
| R8 | Room state (a CRDT document, Yjs) in memory: out of scope for now, studied separately if wanted? | out of scope |
| R9 | The name: `room` (Liveblocks, minivex), `channel` (Supabase, Phoenix) or `presence`? | `room` |

# STUDY-165 — Rooms in the dashboard (a proposed addition)
<!-- index: Rooms in the dashboard: reading the in-memory hub through polled `/api/debug/rooms*` endpoints, a Rooms screen with members and presence, definitions on the Functions screen, counters on Health, an event tap and admin actions | decided (owner, 2026-10-16): AD-43 accepted, every recommendation; steps 1–4 built (the read and the counters) -->

- **Status:** decided. The owner accepted AD-43 on 2026-10-16 with every recommendation of §6: polled `/api/debug/rooms*`
  endpoints, the Rooms screen and the definitions on the Functions screen, the counters, a 1 s period, then the
  event tap, then the actions. This session builds the server side and the data source, with the dashboard session
  building the screens. Steps 1–4 (§5) are built: the read and the counters (#714, #719, #722); steps 5 and 6, the event tap
  and the actions, are built too: their server and sources here (§5.2, §5.3), their screens in STUDY-166.
- **Convex source read:** nothing to read. Convex has no rooms (STUDY-164 §1), so its dashboard has no screen for them.
- **Related:**
  - [STUDY-164](STUDY-164-ephemeral-rooms.md): rooms and presence scopes, AD-42, built.
  - [STUDY-131](STUDY-131-debugging-and-observability.md): `/api/debug/*` and the inspector, AD-25; topology, AD-04.
  - [STUDY-149](STUDY-149-dashboard-real-data.md): the dashboard on a deployment.
  - [STUDY-12](STUDY-12-dashboard.md): the dashboard.

Rooms live only in the server's memory (AD-42). Nothing records who is in a room, what their presence says, how
many rooms are open, or whether members are being rate-limited, refused by a gate or closed for falling behind. A
developer debugging "why don't I see Ana's cursor" has only the client's view. This study looks at what the
dashboard could show and how it would read it, and proposes it as an addition.

## 1. What exists to build on

- **The hub knows everything.** `RoomHub` (`packages/server/src/rooms/hub.ts`) holds every room's key, its
  members, their presence and idle flag, and each attachment's connection, grace and rate buckets. `members(key)`
  already returns a room's members, which actions read through `ctx.rooms.members` and `ctx.presence.list`.
  There is no list of rooms and no counters.
- **The push knows the definitions.** `CodeVersion.rooms` and `AnalyzedModule.rooms` list the deploy's `room()` and
  `presence()` definitions. The Functions screen does not show them.
- **The dashboard reads non-database state through `/api/debug/*`.** AD-04's topology polls
  `/api/debug/topology`. AD-25's inspector reads `/api/debug/subscriptions` and `/api/debug/query_cache` once per
  call, and follows `/api/debug/invalidations` as a long poll from a cursor, the way the log stream works
  (`packages/dashboard-source/src/inspector.ts`). All of them use the admin key and sit behind the dashboard's CORS
  layer.
- **The Health screen reads counters.** `DeploymentStats` (`packages/dashboard/src/data-source.ts`) carries totals
  since the server started, sampled by `watchStats`.

## 2. How the dashboard would read rooms

| Option | How | For | Against |
|---|---|---|---|
| **A. Admin HTTP, polled** | `GET /api/debug/rooms` and `GET /api/debug/rooms/members?key=…`, read every 1–2 s while the screen is open | The AD-04/AD-25 pattern exactly; no protocol change; one snapshot per read, nothing kept per viewer | Presence can lag by up to the polling period |
| **B. Live push over the sync connection** | An admin-only subscription to the hub's changes | Live to the tick | A new admin channel in the sync protocol; the hub would keep per-viewer state |
| **C. Snapshot into a system table** | The hub writes its state periodically | The Data screen could show it as is | Contradicts AD-42's rule that rooms never touch the database; adds writes |

**Recommended: A.** It matches what the dashboard already does for in-memory state. A 1 s period is far below
anything a person reads off a screen. The event tap (§3.3) is the one live view, and it follows the invalidations
feed's long poll, not a new channel. In a multi-node deployment the endpoints are the leader's, since the leader
owns the rooms (STUDY-164 §3.7, R5).

## 3. What the dashboard would show

### 3.1 Read (the base)

- **A "Rooms" screen.** It lists the open rooms and presence scopes: the definition's name, its kind (room or
  scope), the args (canonical JSON, shortened), the number of members, and the number of attached connections
  (a scope's user may have several tabs). The list can be filtered by definition and sorted by members.
- **A room's detail.** Its members:
  - for a room: memberId, userId, presence (JSON), whether it can publish, and whether a connection is in its
    reconnect grace;
  - for a scope: userId, state, idle, and the number of tabs.

  The list refreshes while the screen is open. A member's presence opens in the same JSON viewer the Data screen
  uses.
- **The Functions screen** lists the deploy's `room()` and `presence()` definitions with their modules, beside the
  functions, with their args, presence or state validators, events and whether they have gates. This is cheap:
  the push already finds them.

### 3.2 Counters (observability)

New counters in the hub, totals since the server started:
- joins;
- joins refused by a gate;
- joins refused by a limit;
- leaves;
- grace expiries;
- presence updates and events accepted;
- presence updates and events dropped by the rate limit;
- resyncs, meaning connections closed for falling behind;
- `RoomLeft` sent.

Gauges: open rooms, members and attachments. They would be added to `DeploymentStats`, so that the Health screen
can chart them, and to the Prometheus `/metrics` endpoint (STUDY-114).

### 3.3 The event tap

In a room's detail, a live list of the events that pass through it: event name, sender's memberId (or "server"),
size and time, with the data expandable, pause and a filter by event name. It shows only events from the moment
it opens, as a new member would see them (STUDY-164 §3.1). It is followed as
`/api/debug/rooms/events?key=…&cursor=…`, a long poll over a bounded ring buffer the hub keeps per tapped room,
and only while someone taps it. Presence changes are not in the tap. The member list (§3.1) shows them.

### 3.4 Actions (they change state)

- **Send a test event.** The detail screen gets a form that picks a declared event, edits its data (validated
  against the event's validator, as the function runner validates args) and broadcasts it from the server
  (`from: null`), the same as `ctx.rooms.broadcast`.
- **Remove a member, or close a room.** The server ends the membership with `RoomLeft` (code `removed`, message
  "Removed from the dashboard."). The client does not rejoin a `removed` membership on a new token or a reconnect,
  only when the app joins the room again (§5.3). Removing a scope user ends all of their tabs. Closing a room
  removes everyone.

Both are logged in the audit log, as the dashboard's other writes are, and both need a write-capable admin key
(`Capabilities.readOnly` refuses them). Built as §5.3 says.

## 4. Constraints

- **Privacy.** Presence and event data can hold user data. Access is the admin key's, as for documents. The
  existing read-only credential can read but not act (§3.4).
- **Cost to the hub.**
  - A read builds one snapshot and keeps nothing per viewer.
  - A member list is paginated for big rooms (500 members): first 100, then on demand.
  - Presence values are sent as stored (wire JSON), and the dashboard shortens them on display.
  - The event tap's ring buffer exists only while tapped, holds at most 200 events, and expires 30 s after its last
    poll.
  - Measured as CONTRIBUTING asks: the hub's fan-out with and without a tap on a 100-member room.
- **No change for apps that don't use rooms.** The endpoints answer an empty list, and the counters stay at zero.
- **The mock data source** gets fake rooms, scopes and an event stream, so that the screens work and are tested
  without a server, as every screen is (UI-01).
- **Capabilities.** A deployment without rooms support (an older bunvex) answers 404 on the endpoints. The
  dashboard then hides the screen, as STUDY-149 does for screens a deployment doesn't offer.

## 5. Plan, if accepted

The parts can ship in this order, one PR each:
1. **Server side.** The hub's room list, members page and counters, and the `/api/debug/rooms*` endpoints. Tests,
   and a measurement. Built: #714.
2. **Data source.** The contract (`listRooms`, `listRoomMembers`, `watchRoomEvents`, `getStats` with the new
   counters), the server source and the mock. Built: #719.
3. **Screens.** The Rooms screen with its detail, and the definitions on the Functions screen, with Playwright e2e
   tests. Built: #722 (§5.1).
4. **Health.** The room counters on the Health screen. Built: #722, with step 3 (§5.1), on the Overview (the screen
   that was Health).
5. **Event tap.** The ring buffer and the long poll on the server, and the panel on the screen. The server, the
   contract's `watchRoomEvents`, the server source and the mock: built (§5.2); the panel: built (STUDY-166).
6. **Actions.** Send a test event, remove a member, close a room, with the audit log. The server, the contract, the
   server source and the mock: built (§5.3); the screen's controls: built (STUDY-166).

Parts 1–4 are the read and observability base. Parts 5 and 6 can wait for the owner's go-ahead (D6, D7). The
dashboard is the other session's area (sandbox-86), so the screen PRs would be coordinated with it.

### 5.1 Screens (step 3)

Built in PR #722, on the data source of step 2 (`listRooms`, `listRoomMembers`, `listRoomDefinitions`,
`getStats().rooms`). Steps 3 and 4 of the plan ship together: the counters are small.

**The Rooms screen** (`/rooms`, `packages/dashboard/src/rooms/`), in the sidebar's Observe group after Subscriptions
and in the command palette.
- It is gated as STUDY-149's other optional screens (`offered-screens.tsx`): listed only for a source with
  `listRooms`; a typed URL on a source without it says "This deployment does not offer a view of its rooms and
  presence scopes yet." A deployment that has the method but no rooms (an older bunvex) answers `not_found`, shown
  as the empty state "This deployment does not run rooms.", not as an error.
- The list is a data grid: definition, kind (Room or Presence scope), args (the dashboard's literal notation on one
  line, shortened past 80 characters), members, connections, opened (relative, the absolute time in its tooltip).
  Its order is the source's, by name then key, whose last part is the args; "Sort by Members" puts the most members
  first, keeping that order on ties. A definition filter keeps one definition's rooms. Filter, sort and the open room
  are in the URL (`?name=`, `?sort=members`, `?room=<key>`).
- A room opens in the docked side panel (UI-01 §22.1): kind, args (the literal view the document panel uses),
  members, connections, opened, then the members as a list, a page of 100 at a time ("Load 100 more"). A room's
  member shows memberId, userId ("Signed out" for `null`), "Cannot publish" and "Reconnecting" (`graced`) badges,
  connections, joined, last activity and the presence; a scope's user shows userId, "Idle", tabs (connections),
  "Reconnecting", joined, last activity and the state. A presence or state shows on one line and opens, in place, to
  the whole value. A list, not a grid: the panel is 416 px wide by default and a member has eight facts.
- A room that leaves the list has closed (its last member left). The panel keeps the room as last listed, says
  "Closed — its last member left. This is what it showed last." in a status line, dims the members and stops asking
  for them; no error is shown. A link to a room that was never seen open in this visit says "This room is not open:
  it closed, or the link is old."
- The members and the list are two polls, and either may hear first that the room closed. Once it has, the members
  page is empty (a room with no member is not open), so an empty page after members were shown is the room closing:
  the members last shown stay (dimmed), and the list is asked at once to say it closed. Without this, a members poll
  landing just before the list's showed "No member was listed." under "Closed" (the flaky test fixed in #724).
- No `viewMetrics`: "This credential cannot view the deployment's rooms.", as the Subscriptions screen.

**The definitions on the Functions screen** (`packages/dashboard/src/functions/rooms.tsx`). The function tree stays
Convex's, built from `listFunctions` alone; the definitions are a second navigation, "Rooms and presence", under it
in the same column, filtered by the same search. One opens as `/functions?room=<name>`: its kind and module, the
args validator, the presence (a room's) or state (a scope's) validator as `v.*` code (the function view's
`ValidatorCode`), the events with their payloads, and "Open rooms", a link to the Rooms screen filtered to it. They
are read under the function list's query key, so a push heard by `watchFunctions` lists them again; a deployment
without rooms (`not_found`) shows no list and no error.

**The counters on the Overview** (the screen that was Health, UI-01 §27; `packages/dashboard/src/screens/room-
counters.tsx`). A collapsed "Rooms" section, beside the Engine one, present only when the stats carry `rooms`. Its
summary line says the gauges from the Overview's own stats samples ("2 open, 8 members, 9 connections"); opened, it
shows the three gauges as they are and each counter's total with its rate per second between the last two samples
(0 across a restart, when a counter goes back): joins with the refusals by a gate and by a limit, leaves with the
grace expiries, presence updates and events with the ones dropped by the rate limit (a warning line when more were
dropped since the last sample), resyncs, and memberships ended (`RoomLeft`).

**Polling (D5).** The list, an open room's members and the open Rooms section are read every second
(`ROOMS_POLL_MS`) through TanStack Query's `refetchInterval`, which does not run while the tab is hidden. While the
deployment is disconnected nothing is asked (STUDY-149 PR 6); `rooms` joined the polled reads that are asked again
at once when it comes back (`connection.tsx`). Nothing is read for rooms while no rooms view is shown.

**Tests.**
- Unit (happy-dom, axe without contrast): `test/rooms.test.tsx` (the words; the list, filter, sort; a room's and a
  scope's members; closing; a stale link; paging; `not_found`; another error with retry; no `viewMetrics`; the
  1 s polls; disconnection), `test/functions-rooms.test.tsx`, `test/overview-rooms.test.tsx`, and the offered-screens
  and sidebar tests extended for Rooms.
- E2E in Chromium on the mock (`apps/dashboard/e2e/dashboard.e2e.ts`): the list, a room's members polled (a cursor
  moves), a presence opened, the definition, the Overview's section; axe with contrast in both themes.
- E2E in Chromium on a live server (`packages/sync-e2e/dashboard/rooms.e2e.ts`): no room at first; a client joins and
  sets its presence; the room and its member show within a poll; the definitions; the Overview's counters; the
  client leaves and the panel says closed with no alert; axe.

**Sabotage** (each restored, `git diff` clean after each):

| Broken | Caught by |
|---|---|
| A room missing from the list shown as "unknown" instead of "closed" | words test, closing test |
| The list not polled | closing test, polls test |
| `not_found` handled as an error | the empty-state test |
| Rooms not gated on `listRooms` | four offered-screens tests |
| `rooms` not asked again on reconnection | disconnection test |
| The Overview section shown without `rooms` | "stats without rooms" test |
| A rate taken across a restart | rates test |
| The definitions inside the function tree's navigation | the Functions tree test, the definitions test |
| An open room's members not polled | polls test |
| A closed room's members still polled | closing test (the members stay after a second poll) |
| An empty members page shown as "nobody is in it" before the list says closed | the members-poll-first test |
| The list not asked at once after an empty members page | the members-poll-first test |

### 5.2 The event tap (step 5: server, contract, sources)

**The hub** (`packages/server/src/rooms/hub.ts`) keeps a tap per room someone polls (`taps`, by room key; the room
holds a reference too, so that recording does not build the key). A tap holds at most 200 events (`TAP_EVENTS_MAX`,
the oldest dropped) and a `seq` that starts at 0 when the tap is created and grows by one per event. It ends 30 s
after its last poll (`TAP_IDLE_MS`, on the hub's timers; a poll still waiting keeps it; no timer without taps), and
when its room closes. Every event fanned out is recorded — a member's (`from`: its memberId) and the server's
(`ctx.rooms.broadcast`, `from: null`) — as `{ seq, at, event, from, size, data }`, `size` the bytes of the data's
JSON. Data over 16 KiB of JSON (`TAP_DATA_MAX_BYTES`; room payloads are 4 KB by default, but that is a knob) is
recorded as `data: null, dataOmitted: true` with the real size. Presence changes are not recorded. A room no one
taps costs one field check per event.

**The endpoint** `GET /api/debug/rooms/events?key=&cursor=[&timeoutMs=]`, with the other rooms routes' guard
(the admin key, ViewMetrics) and CORS:
- every answer of a tap carries its `epoch`, a random id made with the tap;
- no cursor: starts the tap (if no one did) and answers `{ events: [], newCursor: <seq>, epoch }` at once;
- a cursor: the events after it, or a long poll (as the invalidations feed: up to 60 s, a waiter woken by the next
  event, never holding the hub) answered `{ events: [], newCursor: cursor }` at its end. A cursor behind the oldest
  event held adds `dropped: <oldest seq − cursor − 1>`. A cursor for a tap that is gone (it expired; the server
  restarted, so the cursor is ahead of the tap's seq) is answered `{ events: [], newCursor: <seq>, reset: true }` and
  the tap starts again. A tap that expired and was made again by another viewer since, with a seq past the cursor,
  is told apart by its epoch: the source turns an epoch change into a gap.
- a room that is not open: `{ events: [], newCursor: cursor ?? 0, closed: true }`, no tap kept;
- a malformed key or cursor: 400.

**The contract** (`watchRoomEvents(room, onEvents(events, { dropped, gap }), onError, onClosed)`): a live tail from
the call on, in seq order, never synchronously. `dropped` passes the server's count; `gap` says the source lost
track (a reset, or a transient failure retried), and the screen never compares seqs across it. Transient failures
(network, 5xx, a disconnection) are retried with the inspector's backoff, the tap started again without a cursor,
and the first batch after says `gap: true` (it may be empty); so does an epoch that changed. `onError` only for a
terminal error (`not_found`, `unauthorized`, `invalid_request`), then nothing more; `onClosed` when the room is not
open, then nothing more — except just after a recovery, when a room found closed is asked again every second
(`ROOM_CLOSED_RETRY_DELAY_MS`) for 10 s from the first answer that found it so (`ROOM_CLOSED_RETRY_MS`): a server
that restarted has the room again only once its members reconnect, however long it took to come back. The
callbacks run outside the request's error handling: a consumer's exception ends the tap and surfaces.

**The mock** (`packages/dashboard/src/mock/rooms.ts`): while tapped, the document room sends a `wave` from one of
its members at every multiple of 3 s on the mock clock (`roomEventIntervalMs`), each a function of the seed and its
mock time, so a screenshot at a given mock time is reproducible (from the server, `null`, if no member may publish); `rooms.emit(key, event, data)` lets a test
push one and `rooms.close(key)` ends a tap with `onClosed`. The contract suite's tap tests run on the mock and on a
live server (`roomEvents` in the contract options, a room of their own driven by a real client).

**Measured** (`bench/rooms-tap.ts`, 100 members, 20 000 events a run through `RoomHub.broadcast`, sinks that only
count, timers that never fire so that no run leaves an expiry behind, median of 9 interleaved runs, two rounds, an
Apple M1 Pro): untapped 1.22–1.24 M events/s against 1.17–1.20 M with main's hub (no change within the noise); tapped
0.99–1.00 M events/s, about 81 % of untapped, some 200 ns more per event (the data's JSON for its size, the record). The sinks do no I/O here; with sockets the fan-out costs far
more per event, and the tap's share is smaller.

### 5.3 The actions (step 6: server, contract, sources)

**The hub.** `removeMember(key, memberId)` ends a member at once, without the reconnect grace: each live attachment's
sink is told to evict it (`RoomSink.evict`, which `RoomConnection` implements by sending `RoomLeft` through the
same path as an identity's refusal, counting `roomLeft`, and forgetting the room); an attachment in its grace just
leaves, its timer cleared. The others see the member leave on the next tick. A scope's member is its user, so every
tab on every connection ends. A member removed in its grace is remembered for what was left of it (`graceMs`): that
session's reconnect is answered with `RoomLeft` `removed` instead of the member back (once; another session, or a
join after the window, joins). A removal that lands while a new identity's gates run stands: their verdict is not
applied to a room evicted meanwhile. It answers `{ connections }`, or null when the room is not open or has no such member.
`closeRoom(key)` removes every member, answers `{ members, connections }` (null when not open), and ends a tap on the
room at once.

**The endpoints**, POST with a JSON body, beside the other rooms routes and under the same CORS layer:
- `/api/debug/rooms/broadcast {key, event, data}`: `data` in the wire's JSON form. Checked by the code
  `ctx.rooms.broadcast` uses (`checkedRoomEvent` in `rooms/ctx.ts`): an event the room does not declare, data its
  validator refuses, or JSON over the client events' limit ("The event is 5123 bytes (limit 4096).", the words a
  client's own event is refused with too) are 400 with the words app code is thrown. A room that
  is not open is 404 `{ code: "RoomNotOpen" }`, nothing sent. Otherwise the event goes out from the server
  (`from: null`), and the tap records it. 200 `{}`.
- `/api/debug/rooms/remove {key, memberId}`: `{ removed: { connections } | null }`.
- `/api/debug/rooms/close {key}`: `{ closed: { members, connections } | null }`.

They need `WriteData`, the operation of the dashboard's other data writes, which a read-only key lacks (403
`OperationNotPermitted`). Each action that did something is recorded in the deployment audit log as the dashboard's
other writes are, `insertAuditLogEvents` with `auditActor(caller)`: the admin key's member (`member_id`), the request's
IP and user agent. The events are bunvex's own (Convex has no rooms): `broadcast_room_event { room, args, event }`,
`remove_room_member { room, args, member_id, connections }` and `close_room { room, args, members, connections }`,
`args` the room's canonical args as JSON text. The action happens in memory before its record: a failed audit write
is logged and the answer still given, so that a retry does not act twice.

**The protocol and the client.** `RoomLeft`'s code gains `removed`. The client keeps a membership ended with
`removed` ended across a new Authenticate (a token refresh) and a reconnect, where `no_access` and `limit` are retried
as before; the app joining the room again (a new `joinRoom` or `useRoom` after the last handle left) joins it. A
removal is an eviction, not a ban. A member in its grace when removed is told on its reconnect (above).

**The contract**: `broadcastRoomEvent(room, event, data)`, `removeRoomMember(room, memberId) → { connections } | null`
and `closeRoom(room) → { members, connections } | null`. A credential that may not write is refused with
`unauthorized` (the contract's code for every refused write; it has no `forbidden`); a broadcast's refusals are
`invalid_request` with the server's words, and a room not open `not_found`. The server source POSTs with the admin
key. The mock acts on its fake rooms, refusing what the server refuses (DV-479): each member has a simulated client
that records the events it got and the RoomLeft that ended it, the counters move (`leaves`, `roomLeft`), a tap sees
the broadcast, and closing ends the taps. The contract suite's actions tests run on the mock and on a live server
(`roomActions` in the contract options, with real clients), with a live test that a removed client stays out across
a token refresh.

## 6. Questions for the owner

| # | Question | Proposed | Decided (owner, 2026-10-16) |
|---|---|---|---|
| D1 | Take this as an addition (AD-43): the dashboard shows rooms and presence scopes | yes | yes |
| D2 | Read them through polled `/api/debug/rooms*` endpoints (A), not a live sync channel (B) or a system table (C)? | A | A |
| D3 | A Rooms screen with a room's detail (members, presence, grace, can-publish), plus the definitions on the Functions screen? | yes | yes |
| D4 | Room counters and gauges in `DeploymentStats`/Health and in `/metrics`? | yes | yes |
| D5 | Polling period while the screen is open | 1 s | 1 s |
| D6 | The event tap (a bounded buffer kept only while tapped)? | yes, after D1–D4 | yes, after D1–D4 |
| D7 | Actions: send a test event, remove a member (`RoomLeft`), close a room, audit-logged and refused to read-only keys? | yes, last | yes, last |
| D8 | Who builds the screens: this session (server, data source) with the dashboard session (screens)? | yes | yes |

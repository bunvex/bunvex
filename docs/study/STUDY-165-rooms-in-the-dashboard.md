# STUDY-165 — Rooms in the dashboard (a proposed addition)

- **Status:** decided. The owner accepted AD-43 on 2026-10-16 with every recommendation of §6: polled `/api/debug/rooms*`
  endpoints, the Rooms screen and the definitions on the Functions screen, the counters, a 1 s period, then the
  event tap, then the actions. This session builds the server side and the data source, with the dashboard session
  building the screens.
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
- **Remove a member, or close a room.** The server ends the membership with `RoomLeft` (code `no_access`, message
  "Removed from the dashboard."), which the client already treats as final. Removing a scope user ends all of
  their tabs. Closing a room removes everyone.

Both are logged in the audit log, as the dashboard's other writes are, and both need a write-capable admin key
(`Capabilities.readOnly` refuses them).

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
   and a measurement.
2. **Data source.** The contract (`listRooms`, `listRoomMembers`, `watchRoomEvents`, `getStats` with the new
   counters), the server source and the mock.
3. **Screens.** The Rooms screen with its detail, and the definitions on the Functions screen, with Playwright e2e
   tests.
4. **Health.** The room counters on the Health screen.
5. **Event tap.** The ring buffer and the long poll on the server, and the panel on the screen.
6. **Actions.** Send a test event, remove a member, close a room, with the audit log.

Parts 1–4 are the read and observability base. Parts 5 and 6 can wait for the owner's go-ahead (D6, D7). The
dashboard is the other session's area (sandbox-86), so the screen PRs would be coordinated with it.

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

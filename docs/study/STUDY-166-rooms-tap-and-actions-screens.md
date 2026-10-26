# STUDY-166 — The Rooms screen's event tap and actions (AD-43 steps 5 and 6)
<!-- index: The Rooms screen's event tap and actions (AD-43 steps 5 and 6): a live event panel on `watchRoomEvents`, and confirmed controls to send a test event, remove a member and close a room, with their History words | implemented (this PR) -->

- **Status:** implemented (this PR).
- **Convex source read:** nothing to read. Convex has no rooms (STUDY-164 §1), so its dashboard has no screen for
  them. AD-43 is an addition the owner accepted on 2026-10-16 (STUDY-165 D1, D6, D7).
- **Related:** [STUDY-165](STUDY-165-rooms-in-the-dashboard.md) §3.3–3.4 (what the tap and the actions are), §5.2–5.3
  (their server, contract and sources: #725, #727); [STUDY-164](STUDY-164-ephemeral-rooms.md) (rooms).

STUDY-165 built the server side, the contract and both sources of the tap and the actions. This study covers their
screens: the panel that follows a room's events, and the controls that send a test event, remove a member and close
a room. They follow the dashboard's own patterns: the Logs screen for a live list, `ConfirmButton` for a write that
asks first, and the Data screen for a read-only credential.

## 1. How Convex does it

It doesn't: Convex has no rooms. The patterns reused are bunvex's own, and the Logs screen's live list already
follows Convex's (STUDY-12 §7).

## 2. What an app can observe

Nothing new on the wire. The screens use the contract as STUDY-165 §5.2–5.3 defines it:
- `watchRoomEvents(room, onEvents(events, { dropped, gap }), onError, onClosed)`;
- `broadcastRoomEvent(room, event, data)`;
- `removeRoomMember(room, memberId) → { connections } | null`;
- `closeRoom(room) → { members, connections } | null`.

An app sees what a dashboard user does with them: a test event from the server (`from: null`), and a member ended
with `RoomLeft` `removed`. Each action leaves an entry in the audit log.

## 3. How bunvex does it

All in `packages/dashboard/src/rooms/`.

**The event tap** (`event-tap.tsx`, with the pure rows in `tap.ts`):
- **Where.** A section of a room's panel. Only for a room: a presence scope has no events (STUDY-164).
- **Subscription.** `watchRoomEvents` starts when the panel opens and stops when it closes, or when the room it
  shows changes. It does not start for a room the list already says has closed.
- **Look.** The same as the Logs screen's lines:
  - newest first, with the time to the millisecond (`formatLogTime`);
  - a bar with Live / Resume (and how many events wait), a filter by event name, and Clear;
  - a grid with seq, time, event, from (a memberId, or "server"), size and data (on one line);
  - a click on a row shows that event's data in full below the grid.
- **Omitted data.** An event whose data was omitted (over 16 KiB) says "Omitted: over 16 KiB" in its data cell.
  Its details give the real size.
- **Notices.** `dropped > 0` and `gap` each become a notice row, placed in the stream before the batch's events. A
  dropped notice says how many events were lost. A gap notice says events may be missing and that seq starts again.
  Rows have an id of their own, because seq starts again after a gap.
- **Limits.** At most 1 000 rows are kept, and the oldest go first.
- **Paused.** New rows wait. Clear hides what is shown.
- **Errors and close.**
  - `onError` is terminal. The panel says "The tap stopped: …", and the Live button goes away.
  - `onClosed` ends the tap ("The room closed: the tap ended.") and asks the room list again at once, so the panel
    says the room closed without waiting for the next poll.

**The actions** (`actions.tsx`):

Common to all three:
- **Who sees them.** They show only when the source offers the method and the credential may write (`writeData`,
  not `readOnly`). A credential that may not write sees a "Read-only: …" note instead, as on the Data screen.
- **Closed rooms.** A closed room has no actions.
- **Refusals.** A refusal is said in the dialog, which stays open. This includes `unauthorized` from a source whose
  capabilities did not foresee it.
- **After an action.** The outcome is said in the panel, and the list and members are asked again.
- **No dry run.** Every count shown comes from data the screen already loaded (`RoomInfo`, `RoomMember`).

The three actions:
- **Send test event.**
  - The dialog has an event name, with the room's declared events suggested and the first one filled in.
  - It has the data as JSON, starting from the payload validator's template (`defaultValueFor`). The dashboard's
    value syntax is accepted too, since JSON is a subset of it.
  - Data that does not parse is refused in the dialog and never sent.
  - The server's `invalid_request` words are shown as they are, e.g. "The event is 5012 bytes (limit 4096).",
    'This room has no event "nope".', and "ArgumentValidationError: …".
- **Remove** (on each member).
  - The dialog gives the member's connections ("tabs" for a scope's user) and "This is not a ban: they'll be back
    only if their app opens the room again (e.g. a reload)."
  - A `null` result is "… had already left.", not an error.
- **Close room** (or **Close scope**).
  - The dialog gives the members and connections from the list, with the same sentence.
  - A `null` result is "It had already closed."
  - After a close, the panel's closed notice says "Closed from the dashboard."

**History** (`history/describe.ts`): a Rooms area in the action filter ("Test event sent", "Member removed", "Room
closed"), and words built from `metadata.room` and `metadata.args`. The args are left out when they are `{}`:
- "Sent the test event wave to rooms:doc {"id":"x"}"
- "Removed member m1 from rooms:doc {"id":"x"} (2 connections)"
- "Closed presence:online: 1 member, 1 connection"

## 4. Divergences

None: Convex has no rooms. The screens are part of AD-43, already accepted.

| # | Divergence | Why | Decision |
|---|---|---|---|

## 4b. Additions (beyond Convex)

None new. This is AD-43's steps 5 and 6 (STUDY-165 D6, D7, accepted).

| # | Addition | Why | Decision |
|---|---|---|---|

## 5. Tests

- `packages/dashboard/test/rooms-tap-actions.test.tsx` (on the mock, which drives the tap with `rooms.emit` and
  `rooms.close` and records each member's client with `rooms.client(key, memberId)`).
  - **The rows:** order, notices before a batch's events, unique ids across a gap, pause / resume / clear, the cap,
    the filter, and the data parser and template.
  - **The tap:**
    - every column, and the details on a click;
    - omitted data;
    - dropped and gap rows (from a stubbed source);
    - pause, resume, filter and clear;
    - it stops when the panel closes, and never starts for a scope;
    - a terminal error;
    - a closing room, with the list asked at once.
  - **The actions:**
    - a test event reaches every client and the tap from the server, with its audit entry;
    - the server's three refusals are shown in the dialog, and bad JSON is never sent;
    - a removal (its dialog text, the client ended `removed`, the member gone, the audit entry);
    - a scope user's tabs, and a removal that finds the member already gone;
    - a close (its counts, every client ended, the panel closed, the audit entry), and a close that finds the room
      already closed;
    - a read-only credential sees no controls, and the source refuses it;
    - an unforeseen `unauthorized` is shown in the dialog.
- `packages/dashboard/test/history.test.tsx`: the three events in words and their area.
- `apps/dashboard/e2e/dashboard.e2e.ts` (Chromium, both themes, axe): the mock's waves arrive in the tap; a test
  event sent through its dialog shows from the server; the close dialog shows its counts and is cancelled.

**Sabotage**: each break below was made alone, the tests run, then restored (`git diff` clean after).

| Break | Caught by |
|---|---|
| A batch's notices after its events | 4 row tests |
| The tap not stopped on unmount | the tap stops when the panel closes |
| `onError` not terminal (Live stays) | a terminal error |
| `dropped` ignored | the row tests |
| A server refusal closes the dialog unsaid | what the server refuses is said in the dialog |
| A `null` removal said as done | a member already gone is said so |
| A `null` close said as done | a room already closed when confirmed |
| `readOnly` ignored | a read-only credential sees no action |
| The removal dialog without how they come back | remove a member: the dialog says … |
| `close_room` without words | events in words |
| The tap's close not asking the list (5 of 5 runs) | the room closing … without waiting for the list's poll |

## 6. Open questions

None.

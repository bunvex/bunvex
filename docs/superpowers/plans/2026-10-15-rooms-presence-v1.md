# Rooms and presence scopes (AD-42 v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rooms (a member per connection, with presence and broadcast events) and presence scopes (one entry per
signed-in user), held in the server's memory beside the database, never in it, as STUDY-164 decided.

**Architecture:** An app defines a `room()` or a `presence()` in its functions directory. Codegen and push recognise
them like functions; queries never see them. A `RoomHub` in the server process owns every room's members. It runs
the reconnect grace, the rate buckets, the member cap and a per-tick coalescing of presence. `SyncSession` carries
new protocol v1 messages (`RoomJoin`…, `RoomSync`…) beside the query traffic. It runs a definition's gates as
queries with the connection's identity. Mutations broadcast through a new after-commit hook on the core `Tx`.
Actions broadcast and read members directly. The client gets `joinRoom` / `joinPresence` with ref-counted
memberships that rejoin on reconnect, and React gets `useRoom` (sub-hooks) and `usePresence`.

**Tech Stack:** Bun, TypeScript, `bun:test`, React 19 (`useSyncExternalStore`), happy-dom for the React tests.

**Spec:** `docs/study/STUDY-164-ephemeral-rooms.md` (decided 2026-10-15; R1–R9 in its §6), and AD-42 in
`docs/parity/additions.md`.

## Global Constraints

- Everything in the repo is in English: code, docs, commits and PRs (CLAUDE.md).
- **No "convex" in shipped code** outside comments: not in identifiers, strings, error messages or URLs.
  `bun run check:deps` (rule 5) enforces it.
- No divergence from Convex. Rooms are opt-in, and invisible to an app or a client that does not use them
  (STUDY-164 §2, §4). Convex's client never sends the new messages, and the server never sends room frames to a
  connection that did not join a room.
- Not an in-memory database: queries and mutations never read room state (STUDY-164 §3.2). Reading members is
  for actions only (R3).
- A room's member is a connection. A scope's member is a signed-in user, present while any of their connections
  is (§3.3, §3.5).
- Mutations broadcast **after the commit**, and not at all if the mutation fails or retries (R3, §3.4).
- Gates (`canJoin`, `canPublish`) run with a query's ctx at join, and again on an identity change; never
  reactively (R4).
- Reconnect grace: **5 s**; a reconnect within it keeps the member, its presence and its rooms, and the others
  see no leave or join (R4).
- Throttling: the client sends presence at most every **50 ms**, on the leading and trailing edge. The server
  coalesces per tick (**≈30 ms**).
- Limits (R6, all knobs):

  | Limit | Default |
  |---|---|
  | presence and event payloads (as JSON) | 4 KB each |
  | room args | 4 KB |
  | rooms per connection | 64 |
  | presence updates per member | 40 /s |
  | events per member | 10 /s |
  | members per room | 500 |

  Excess updates and events are dropped, with one warning per second.
- Membership frames are never dropped. A client too far behind is disconnected and re-syncs on reconnect (§3.5).
- The wire messages are those of §3.6 (`RoomJoin`, `RoomLeave`, `RoomPresence`, `RoomEvent`; `RoomSync`,
  `RoomMembers`, `RoomEvent`, `RoomError` with codes `no_access`, `forbidden`, `validation`, `rate_limited`,
  `limit`). They travel beside `Transition` frames, never inside them.
- Multi-node is out of scope for v1: single process. With followers (later, R5), relay through the leader.
- Out of scope: onJoin/onLeave hooks (R7) and room state / CRDT (R8).
- CONTRIBUTING: a behaviour change comes with tests and a sabotage check, and a change that can affect
  performance comes with a measurement. `bun run check` passes before every push.
- One PR per concern. The task groups below are the PRs, and the owner merges.
- Never start a source file with `// @bun…`.

## Review Focus

1. **A gate that throws or reads a missing document.** The join is refused with `no_access`, and the message
   carries no internals (no stack, no server error text). Pinned in Task 5.
2. **A connection that closes while its `RoomJoin` gate is still running.** The member must not be inserted after
   the close; otherwise it is a ghost no one can remove. Pinned in Task 5.
3. **The same room joined twice by one client** (two components, the same args). One membership, ref-counted;
   leaving from one component keeps the other. Pinned in Task 7.
4. **A mutation that broadcasts and then fails or is retried by OCC.** The event is never sent, or sent exactly
   once for the committed attempt. A nested `ctx.runMutation` that throws drops its broadcasts. Pinned in Task 4.
5. **A user with several tabs in a presence scope, one of which closes.** The user stays, with no leave seen. The
   user leaves only after the last tab's grace ends. Pinned in Task 3.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/protocol/src/v1.ts` (modify) | The new message types; parsing and encoding |
| `packages/server/src/rooms/define.ts` (create) | `room()` / `presence()` builders, `RoomDef` / `PresenceDef`, `isRoomDef` |
| `packages/server/src/rooms/hub.ts` (create) | `RoomHub`: members, grace, coalescing, rate buckets, cap; no WebSocket, no functions |
| `packages/server/src/rooms/limits.ts` (create) | `RoomLimits` and `roomLimitsFromEnv` (knobs) |
| `packages/server/src/rooms/session.ts` (create) | `RoomConnection`: one connection's rooms. Gates, validation, the protocol messages to and from the hub |
| `packages/server/src/rooms/ctx.ts` (create) | `ctx.rooms` / `ctx.presence` for mutations and actions |
| `packages/core/src/tx.ts`, `engine.ts` (modify) | `Tx.afterCommit(fn)`, kept or dropped with savepoints, run after a successful commit |
| `packages/server/src/code-version.ts`, `functions.ts`, `server.ts`, `sync.ts` (modify) | Recognise, install and wire |
| `packages/server/src/api-types.ts`, `registration.ts` (modify) | Typed `api.rooms.doc` references |
| `packages/cli/src/codegen.ts` (modify) | `room` and `presence` in `_generated/server` |
| `packages/client/src/rooms.ts` (create) | `RoomManager`, `RoomHandle`, `PresenceHandle`, the throttle |
| `packages/client/src/base-client.ts` (modify) | Route room frames, rejoin on open, `joinRoom` / `joinPresence` |
| `packages/react/src/rooms.ts` (create) | `useRoom` with sub-hooks, `usePresence` with idle |
| `bench/rooms.ts` (create) | Fan-out latency and CPU, against cursors kept in a table |
| docs (modify) | STUDY-164 "built", AD-42 status, a docs page, parity |

PRs: **A** = Tasks 1–2 (protocol, definitions), **B** = Task 3 (hub), **C** = Task 4 (after-commit hook, core;
coordinate with the components session, which also edits `tx.ts`/`engine.ts`), **D** = Tasks 5–6 (sync wiring and
server ctx), **E** = Task 7 (client), **F** = Task 8 (React), **G** = Task 9 (measurement, docs, example).

---

### Task 1: Protocol messages

**Files:**
- Modify: `packages/protocol/src/v1.ts`. Types after `ClientEvent` (:62); unions `ClientMessage` (:64) and
  `ServerMessage` (127-134); `parseClientMessage` (191-266); `parseServerMessage` (281-298) needs nothing, since
  its default passes messages through.
- Test: `packages/protocol/test/v1.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RoomKind = "room" | "presence";
  export type RoomJoin = { type: "RoomJoin"; roomId: number; kind: RoomKind; name: string; args: JSONValue };
  export type RoomLeave = { type: "RoomLeave"; roomId: number };
  export type RoomPresence = { type: "RoomPresence"; roomId: number; presence: JSONValue; idle?: boolean };
  export type RoomClientEvent = { type: "RoomEvent"; roomId: number; event: string; data: JSONValue };
  export type RoomMember = { memberId: string; userId: string | null; presence: JSONValue | null; idle?: boolean };
  export type RoomSync = { type: "RoomSync"; roomId: number; self: string; canPublish: boolean; members: RoomMember[] };
  export type RoomMembers = { type: "RoomMembers"; roomId: number; set: RoomMember[]; left: string[] };
  export type RoomServerEvent = { type: "RoomEvent"; roomId: number; from: string | null; event: string; data: JSONValue };
  export type RoomErrorCode = "no_access" | "forbidden" | "validation" | "rate_limited" | "limit" | "not_found";
  export type RoomError = { type: "RoomError"; roomId: number; code: RoomErrorCode; message: string };
  ```
  `roomId` is chosen by the client per connection, like `queryId`. A presence scope's member has
  `memberId === userId`. `presence` carries the scope's `state`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/protocol/test/v1.test.ts (append)
describe("room messages", () => {
  test("RoomJoin, RoomLeave, RoomPresence and RoomEvent parse", () => {
    expect(v1.parseClientMessage(JSON.stringify({ type: "RoomJoin", roomId: 1, kind: "room", name: "rooms:doc", args: { docId: "x" } })))
      .toEqual({ type: "RoomJoin", roomId: 1, kind: "room", name: "rooms:doc", args: { docId: "x" } });
    expect(v1.parseClientMessage(JSON.stringify({ type: "RoomLeave", roomId: 1 }))).toEqual({ type: "RoomLeave", roomId: 1 });
    expect(v1.parseClientMessage(JSON.stringify({ type: "RoomPresence", roomId: 2, presence: { x: 1 }, idle: true })))
      .toEqual({ type: "RoomPresence", roomId: 2, presence: { x: 1 }, idle: true });
    expect(v1.parseClientMessage(JSON.stringify({ type: "RoomEvent", roomId: 2, event: "wave", data: null })))
      .toEqual({ type: "RoomEvent", roomId: 2, event: "wave", data: null });
  });
  test("a bad room message is a ProtocolError", () => {
    for (const m of [
      { type: "RoomJoin", roomId: 1, kind: "lobby", name: "a:b", args: {} },
      { type: "RoomJoin", roomId: -1, kind: "room", name: "a:b", args: {} },
      { type: "RoomJoin", roomId: 1, kind: "room", args: {} },
      { type: "RoomPresence", roomId: 1 },
      { type: "RoomEvent", roomId: 1, event: 3, data: 1 },
    ])
      expect(() => v1.parseClientMessage(JSON.stringify(m))).toThrow(v1.ProtocolError);
  });
  test("server room frames encode and parse back unchanged", () => {
    const frames: v1.ServerMessage[] = [
      { type: "RoomSync", roomId: 1, self: "m1", canPublish: true, members: [{ memberId: "m2", userId: "u2", presence: { x: 1 } }] },
      { type: "RoomMembers", roomId: 1, set: [], left: ["m2"] },
      { type: "RoomEvent", roomId: 1, from: null, event: "wave", data: { emoji: "👋" } },
      { type: "RoomError", roomId: 1, code: "no_access", message: "You cannot join this room." },
    ];
    for (const f of frames) expect(v1.parseServerMessage(v1.encodeServerMessage(f))).toEqual(f);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/protocol/test/v1.test.ts -t "room"`
Expected: FAIL. The client messages throw "Invalid message: unknown type …", and the type check of the
server-frame test fails.

- [ ] **Step 3: Implement**

In `v1.ts`, add the types from **Interfaces**. Then:
- add `RoomJoin | RoomLeave | RoomPresence | RoomClientEvent` to `ClientMessage`;
- add `RoomSync | RoomMembers | RoomServerEvent | RoomError` to `ServerMessage`;
- add these cases to `parseClientMessage`, before `default`:

```ts
    case "RoomJoin": {
      if (m.kind !== "room" && m.kind !== "presence")
        throw new ProtocolError("Invalid message: `kind` must be \"room\" or \"presence\"");
      if (!("args" in m)) throw new ProtocolError("Invalid message: `args` is required");
      return { type: "RoomJoin", roomId: u32(m.roomId, "roomId"), kind: m.kind, name: str(m.name, "name"), args: m.args as JSONValue };
    }
    case "RoomLeave":
      return { type: "RoomLeave", roomId: u32(m.roomId, "roomId") };
    case "RoomPresence": {
      if (!("presence" in m)) throw new ProtocolError("Invalid message: `presence` is required");
      return {
        type: "RoomPresence",
        roomId: u32(m.roomId, "roomId"),
        presence: m.presence as JSONValue,
        ...(m.idle === undefined ? {} : { idle: m.idle === true }),
      };
    }
    case "RoomEvent":
      return { type: "RoomEvent", roomId: u32(m.roomId, "roomId"), event: str(m.event, "event"), data: (m.data ?? null) as JSONValue };
```

`encodeServerMessage` (160-169) already handles any frame with no `bigint` fields. Check that it does; if it
switches on type, add a pass-through for the four room frames.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/protocol` (Expected: PASS). Then run `bun run typecheck`.

Expected: FAIL in `packages/server/src/sync.ts:907-914`. `MESSAGE_SPANS` is exhaustive over
`ClientMessage["type"]`, so add these entries:
`RoomJoin: "sync.room_join", RoomLeave: "sync.room_leave", RoomPresence: "sync.room_presence", RoomEvent: "sync.room_event"`.
In `SyncSession.handle` (1218-1300), add a temporary case so the switch stays exhaustive. It is replaced in Task 5:

```ts
      case "RoomJoin":
      case "RoomLeave":
      case "RoomPresence":
      case "RoomEvent":
        return; // rooms are wired in Task 5
```

Rerun `bun run typecheck`. Expected: PASS.

- [ ] **Step 5: Sabotage, then commit**

Sabotage: drop the `kind` check. The "bad room message" test fails. Restore it.

```bash
git add packages/protocol packages/server/src/sync.ts
git commit -m "feat(protocol): room messages (AD-42, STUDY-164 §3.6)"
```

---

### Task 2: `room()` and `presence()` definitions, push and codegen

**Files:**
- Create: `packages/server/src/rooms/define.ts`
- Modify:
  - `packages/server/src/index.ts` (102-122) and `packages/server/src/isomorphic.ts` (14-27, 39): export
    `room`, `presence`, `roomGeneric`, `presenceGeneric`, `isRoomDef`.
  - `packages/server/src/code-version.ts`:
    - `analyze`, 439-512: collect the definitions at :452;
    - the `CodeVersion` constructor, :279/284: add a `rooms` map;
    - `AnalyzedModule`, 51-56: add `rooms: { name: string; kind: RoomKind }[]`.
  - `packages/server/src/functions.ts`: `register`, 1292-1295, accepts room definitions; add a `rooms` map beside
    `fns`.
  - `packages/server/src/server.ts`: `installCodeVersion`, 2188-2202, installs `version.rooms`.
  - `packages/server/src/api-types.ts` (13-27) and `registration.ts` (222-243): typed references.
  - `packages/cli/src/codegen.ts`: `BUILDERS` (125-133), `GENERIC_BUILDERS` (116-124), `BUILDER_DOCS`
    (134-142); and the snapshot `packages/cli/test/__snapshots__/codegen.test.ts.snap`.
- Test: `packages/server/test/rooms-define.test.ts`, `packages/cli/test/codegen.test.ts` (snapshot update).

**Interfaces:**
- Produces:
  ```ts
  // packages/server/src/rooms/define.ts
  export type RoomGate = (ctx: GenericQueryCtx<any>, args: any) => boolean | Promise<boolean>;
  export type RoomDef = {
    kind: "room";
    args: GenericValidator | undefined;
    canJoin: RoomGate | undefined;     // absent: everyone may join
    canPublish: RoomGate | undefined;  // absent: every member may publish
    presence: GenericValidator;
    events: Record<string, GenericValidator>;
  };
  export type PresenceDef = {
    kind: "presence";
    args: GenericValidator | undefined;
    canJoin: RoomGate | undefined;     // signed-in users only, whatever it says
    state: GenericValidator;
  };
  export type AnyRoomDef = RoomDef | PresenceDef;
  export function room(spec: {...}): RoomDef & { isBunvexRoom: true };
  export function presence(spec: {...}): PresenceDef & { isBunvexRoom: true };
  export function isRoomDef(x: unknown): x is AnyRoomDef;
  ```
  - `CodeVersion.rooms: Map<string, AnyRoomDef>` and `Functions.rooms: Map<string, AnyRoomDef>`, keyed like
    functions (`"rooms:doc"`).
  - `Functions.roomDef(name: string): AnyRoomDef | undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/test/rooms-define.test.ts
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { isFunctionDef, isRoomDef, presence, query, room } from "../src/index.ts";

describe("room() and presence()", () => {
  test("room() keeps its gates and validators, and is not a function", () => {
    const canJoin = () => true;
    const r = room({ args: { docId: v.string() }, canJoin, presence: v.object({ x: v.number() }), events: { wave: v.object({}) } });
    expect(isRoomDef(r)).toBe(true);
    expect(isFunctionDef(r)).toBe(false);
    expect(r.kind).toBe("room");
    expect(r.canJoin).toBe(canJoin);
    expect(Object.keys(r.events)).toEqual(["wave"]);
  });
  test("an object of fields is an object validator, as a function's args", () => {
    const r = presence({ args: { channel: v.string() }, state: { name: v.string() } });
    expect(r.state.json).toEqual(v.object({ name: v.string() }).json);
  });
  test("a definition without its validator is refused when it is defined", () => {
    expect(() => room({} as never)).toThrow("room(): `presence` is required");
    expect(() => presence({} as never)).toThrow("presence(): `state` is required");
  });
  test("a query is not a room", () => {
    expect(isRoomDef(query(async () => null))).toBe(false);
  });
});
```

Add a push test to `packages/server/test/rooms-define.test.ts`. It uses the deploy path that
`code-version.test.ts` uses: build a module source with `room` and `query` exports, `CodeVersion.load` it, and
`analyze`. Find the helper there (`loadModules`/`deployCode`, whichever that file uses) and reuse it.

```ts
test("push finds a module's rooms, beside its functions", async () => {
  const version = await loadVersion({
    "rooms.js": `import { room, presence, query } from "@bunvex/server"; import { v } from "@bunvex/values";
      export const doc = room({ args: { id: v.string() }, presence: v.any() });
      export const online = presence({ state: v.any() });
      export const list = query(async () => null);`,
  });
  expect([...version.rooms.keys()].sort()).toEqual(["rooms:doc", "rooms:online"]);
  expect(version.functions.has("rooms:list")).toBe(true);
  expect(version.analyze().find((m) => m.path === "rooms.js")?.rooms).toEqual([
    { name: "doc", kind: "room" },
    { name: "online", kind: "presence" },
  ]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/server/test/rooms-define.test.ts`. Expected: FAIL (`room` is not exported).

- [ ] **Step 3: Implement `define.ts`**

```ts
// packages/server/src/rooms/define.ts
// Rooms and presence scopes (AD-42, STUDY-164 §3.3): definitions an app exports from its functions directory, as
// it exports functions. They are not functions: no client calls them, and no query reads them.
import { type GenericValidator, v } from "@bunvex/values";
import type { GenericQueryCtx } from "../registration.ts";

export type RoomGate = (ctx: GenericQueryCtx<any>, args: any) => boolean | Promise<boolean>;
export type RoomDef = {
  kind: "room";
  args: GenericValidator | undefined;
  canJoin: RoomGate | undefined;
  canPublish: RoomGate | undefined;
  presence: GenericValidator;
  events: Record<string, GenericValidator>;
};
export type PresenceDef = { kind: "presence"; args: GenericValidator | undefined; canJoin: RoomGate | undefined; state: GenericValidator };
export type AnyRoomDef = RoomDef | PresenceDef;

const DEFINED = new WeakSet<object>();
export const isRoomDef = (x: unknown): x is AnyRoomDef => typeof x === "object" && x !== null && DEFINED.has(x);

type Fields = GenericValidator | Record<string, GenericValidator>;
const validatorOf = (x: Fields): GenericValidator =>
  (x as GenericValidator).isValidator === true ? (x as GenericValidator) : v.object(x as Record<string, GenericValidator>);

export function roomGeneric(spec: {
  args?: Fields;
  canJoin?: RoomGate;
  canPublish?: RoomGate;
  presence: Fields;
  events?: Record<string, Fields>;
}) {
  if (spec?.presence === undefined) throw new Error("room(): `presence` is required");
  const def = {
    kind: "room" as const,
    args: spec.args === undefined ? undefined : validatorOf(spec.args),
    canJoin: spec.canJoin,
    canPublish: spec.canPublish,
    presence: validatorOf(spec.presence),
    events: Object.fromEntries(Object.entries(spec.events ?? {}).map(([k, f]) => [k, validatorOf(f)])),
    isBunvexRoom: true as const,
  };
  DEFINED.add(def);
  return def;
}

export function presenceGeneric(spec: { args?: Fields; canJoin?: RoomGate; state: Fields }) {
  if (spec?.state === undefined) throw new Error("presence(): `state` is required");
  const def = {
    kind: "presence" as const,
    args: spec.args === undefined ? undefined : validatorOf(spec.args),
    canJoin: spec.canJoin,
    state: validatorOf(spec.state),
    isBunvexRoom: true as const,
  };
  DEFINED.add(def);
  return def;
}
export const room = roomGeneric;
export const presence = presenceGeneric;
```

Export these from `index.ts` and `isomorphic.ts` (`isomorphic.test.ts` checks that the two lists match).

- [ ] **Step 4: Recognise them at push and in `register`**

In `code-version.ts` `analyze`, at :452, replace `if (!isFunctionDef(value)) continue;` with:

```ts
        if (isRoomDef(value)) {
          rooms.set(`${name}:${exported}`, value);
          analyzedRooms.push({ name: exported, kind: value.kind });
          continue;
        }
        if (!isFunctionDef(value)) continue;
```

- Thread `rooms` the way `functions` is threaded, into the `CodeVersion` constructor (:279/284) and its
  `rooms` field.
- Add `rooms: analyzedRooms` to the module's `AnalyzedModule`.
- In `Functions`, add `rooms = new Map<string, AnyRoomDef>()` beside `fns` (:818).
- `install(fns, hashes, rooms = new Map())`: replace `this.rooms` with the given map.
- `register(module, defs)`: put each entry where `isRoomDef(def)` into `this.rooms` and the rest into `fns`.
- `roomDef(name) { return this.rooms.get(registryKey(name)); }`.
- In `server.ts` `installCodeVersion` (2188-2202), pass `version.rooms` to `functions.install`.

- [ ] **Step 5: Types and codegen**

- In `registration.ts`, beside `RegisteredQuery` (222-243), add:
  ```ts
  export type RegisteredRoom<Args, Presence, Events> = { isBunvexRoom: true; kind: "room"; __args?: Args; __presence?: Presence; __events?: Events };
  export type RegisteredPresence<Args, State> = { isBunvexRoom: true; kind: "presence"; __args?: Args; __state?: State };
  ```
  Type `room()` / `presence()`'s return with these (Infer from the validators).
- In `api-types.ts`, extend `FunctionReferencesInModule` (23-27) to keep the exports whose `isBunvexRoom` extends
  `true`, and map them to:
  ```ts
  export type RoomReference<Kind extends "room" | "presence", Args, P, E = {}> = {
    _type: "room"; _kind: Kind; _args: Args; _presence: P; _events: E; _name?: string;
  };
  ```
  `anyApi` already builds a reference for any path at runtime, and `getFunctionName(ref)`
  (`protocol/src/api.ts:104`) gives `"rooms:doc"`.
- In `codegen.ts`, add rows to `BUILDERS`:
  `["room", "RoomBuilder<DataModel>", "roomGeneric"]` and `["presence", "PresenceBuilder<DataModel>", "presenceGeneric"]`.
  Also add `roomGeneric` and `presenceGeneric` to `GENERIC_BUILDERS`, add docs lines to `BUILDER_DOCS`, and export
  the two builder types from `registration.ts`.
- Run `bun test packages/cli/test/codegen.test.ts --update-snapshots`, then read the snapshot diff. It must add
  only the two exports and their types.

- [ ] **Step 6: Run everything**

Run: `bun test packages/server/test/rooms-define.test.ts packages/server/test/isomorphic.test.ts packages/cli/test/codegen.test.ts`
Expected: PASS. Then `bun run typecheck`, expecting PASS.

- [ ] **Step 7: Sabotage, then commit**

- Sabotage 1: remove the `isRoomDef` branch in `analyze`. The push test fails.
- Sabotage 2: make `isRoomDef` return true for functions. The "a query is not a room" test fails.

```bash
git add packages/server packages/cli
git commit -m "feat(server): room() and presence() definitions, found at push and in codegen (AD-42)"
```

---

### Task 3: `RoomHub` — members, grace, coalescing, limits

The hub knows nothing of WebSockets, functions or validators. It is given connections as `RoomSink`s, it decides
who is in which room, and it emits protocol frames. All of its timing goes through an injected `Timers`, so the
tests drive a fake clock.

**Files:**
- Create: `packages/server/src/rooms/limits.ts`, `packages/server/src/rooms/hub.ts`
- Test: `packages/server/test/rooms-hub.test.ts`

**Interfaces:**
- Consumes: `v1.RoomMember`, `v1.ServerMessage`, `v1.RoomKind` (Task 1).
- Produces:
  ```ts
  // limits.ts
  export type RoomLimits = {
    payloadBytes: number; argsBytes: number; roomsPerConnection: number; presencePerSecond: number;
    eventsPerSecond: number; memberCap: number; graceMs: number; tickMs: number; maxBufferedBytes: number;
  };
  export function roomLimitsFromEnv(env?: KnobEnv): RoomLimits;
  // hub.ts
  export type Timers = { now(): number; set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  export interface RoomSink {
    readonly sessionId: string;            // the protocol session (Connect), or a random id before it
    send(frame: v1.ServerMessage): void;
    behind(): number;                       // bytes queued to this connection
    resync(): void;                         // close it: the client reconnects and rejoins
  }
  export type RoomKey = { kind: v1.RoomKind; name: string; argsJson: string };
  export class RoomHub {
    constructor(limits: RoomLimits, timers?: Timers);
    /** After the gate passed. Rejoins a member kept by the grace silently. Returns the RoomSync sent, or an error code. */
    join(sink: RoomSink, roomId: number, key: RoomKey, who: { userId: string | null; canPublish: boolean }): "ok" | "limit";
    leave(sink: RoomSink, roomId: number): void;
    detach(sink: RoomSink): void;          // the connection closed: every membership enters its grace
    setPresence(sink: RoomSink, roomId: number, presence: JSONValue, idle?: boolean): "ok" | "forbidden" | "rate_limited";
    event(sink: RoomSink, roomId: number, event: string, data: JSONValue): "ok" | "forbidden" | "rate_limited";
    broadcast(key: RoomKey, event: string, data: JSONValue): void;   // from the server: from = null
    members(key: RoomKey): v1.RoomMember[];
    roomsOf(sink: RoomSink): { roomId: number; key: RoomKey }[];
    setCanPublish(sink: RoomSink, roomId: number, canPublish: boolean): void;
    get size(): { rooms: number; members: number };   // for the memory witness
  }
  export const roomKeyString: (k: RoomKey) => string;   // `${kind}|${name}|${argsJson}`
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/test/rooms-hub.test.ts
import { describe, expect, test } from "bun:test";
import type { v1 } from "@bunvex/protocol";
import { type RoomKey, RoomHub, type RoomSink, type Timers } from "../src/rooms/hub.ts";
import type { RoomLimits } from "../src/rooms/limits.ts";

const LIMITS: RoomLimits = {
  payloadBytes: 4096, argsBytes: 4096, roomsPerConnection: 64, presencePerSecond: 40,
  eventsPerSecond: 10, memberCap: 500, graceMs: 5000, tickMs: 30, maxBufferedBytes: 1 << 20,
};
/** A clock the test advances; due timers run in order. */
function fakeTimers(): Timers & { advance(ms: number): void } {
  let now = 0; let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    set: (fn, ms) => { due.set(++seq, { at: now + ms, fn }); return seq; },
    clear: (h) => void due.delete(h as number),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        due.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
  };
}
function sink(sessionId: string): RoomSink & { frames: v1.ServerMessage[]; resyncs: number; queued: number } {
  const s = { sessionId, frames: [] as v1.ServerMessage[], resyncs: 0, queued: 0,
    send: (f: v1.ServerMessage) => void s.frames.push(f), behind: () => s.queued, resync: () => void s.resyncs++ };
  return s;
}
const DOC: RoomKey = { kind: "room", name: "rooms:doc", argsJson: '{"id":"a"}' };
const ONLINE: RoomKey = { kind: "presence", name: "rooms:online", argsJson: "{}" };
const last = (s: { frames: v1.ServerMessage[] }) => s.frames.at(-1);

describe("rooms", () => {
  test("a joiner gets everyone else; the others see it on the next tick", () => {
    const t = fakeTimers(); const hub = new RoomHub(LIMITS, t);
    const a = sink("A"), b = sink("B");
    hub.join(a, 1, DOC, { userId: "u1", canPublish: true });
    hub.setPresence(a, 1, { x: 1 });
    t.advance(30);
    hub.join(b, 7, DOC, { userId: "u2", canPublish: true });
    const sync = last(b) as v1.RoomSync;
    expect(sync).toMatchObject({ type: "RoomSync", roomId: 7, canPublish: true });
    expect(sync.members).toEqual([{ memberId: expect.any(String), userId: "u1", presence: { x: 1 } }]);
    t.advance(30);
    expect(last(a)).toMatchObject({ type: "RoomMembers", roomId: 1, set: [{ userId: "u2", presence: null }], left: [] });
  });
  test("1,000 presence updates in a tick reach a member as one frame with the latest", () => {
    const t = fakeTimers(); const hub = new RoomHub({ ...LIMITS, presencePerSecond: 10_000 }, t);
    const a = sink("A"), b = sink("B");
    hub.join(a, 1, DOC, { userId: null, canPublish: true });
    hub.join(b, 1, DOC, { userId: null, canPublish: true });
    t.advance(30); b.frames.length = 0;
    for (let i = 0; i < 1000; i++) hub.setPresence(a, 1, { i });
    t.advance(30);
    expect(b.frames).toHaveLength(1);
    expect((b.frames[0] as v1.RoomMembers).set).toEqual([expect.objectContaining({ presence: { i: 999 } })]);
  });
  test("an event reaches the others at once, not its sender, and no late joiner", () => {
    const t = fakeTimers(); const hub = new RoomHub(LIMITS, t);
    const a = sink("A"), b = sink("B"), c = sink("C");
    hub.join(a, 1, DOC, { userId: null, canPublish: true });
    hub.join(b, 1, DOC, { userId: null, canPublish: true });
    expect(hub.event(a, 1, "wave", { e: 1 })).toBe("ok");
    expect(last(b)).toMatchObject({ type: "RoomEvent", event: "wave", data: { e: 1 } });
    expect(a.frames.some((f) => f.type === "RoomEvent")).toBe(false);
    hub.join(c, 1, DOC, { userId: null, canPublish: true });
    expect(c.frames.some((f) => f.type === "RoomEvent")).toBe(false);
  });
  test("a spectator can neither set presence nor send events", () => {
    const hub = new RoomHub(LIMITS, fakeTimers()); const a = sink("A");
    hub.join(a, 1, DOC, { userId: null, canPublish: false });
    expect(hub.setPresence(a, 1, { x: 1 })).toBe("forbidden");
    expect(hub.event(a, 1, "wave", {})).toBe("forbidden");
  });
  test("over the rate, updates are dropped and reported once a second", () => {
    const t = fakeTimers(); const hub = new RoomHub(LIMITS, t); const a = sink("A");
    hub.join(a, 1, DOC, { userId: null, canPublish: true });
    const r = Array.from({ length: 15 }, () => hub.event(a, 1, "wave", {}));
    expect(r.filter((x) => x === "ok")).toHaveLength(10);
    expect(r.filter((x) => x === "rate_limited")).toHaveLength(5);
    t.advance(1000);
    expect(hub.event(a, 1, "wave", {})).toBe("ok");
  });
  test("the member cap refuses the next joiner", () => {
    const hub = new RoomHub({ ...LIMITS, memberCap: 2 }, fakeTimers());
    expect(hub.join(sink("A"), 1, DOC, { userId: null, canPublish: true })).toBe("ok");
    expect(hub.join(sink("B"), 1, DOC, { userId: null, canPublish: true })).toBe("ok");
    expect(hub.join(sink("C"), 1, DOC, { userId: null, canPublish: true })).toBe("limit");
  });
  test("rooms per connection are capped", () => {
    const hub = new RoomHub({ ...LIMITS, roomsPerConnection: 1 }, fakeTimers()); const a = sink("A");
    expect(hub.join(a, 1, DOC, { userId: null, canPublish: true })).toBe("ok");
    expect(hub.join(a, 2, { ...DOC, argsJson: '{"id":"b"}' }, { userId: null, canPublish: true })).toBe("limit");
  });
});

describe("the reconnect grace", () => {
  test("a reconnect within it keeps the member: no leave, no join, the same memberId and presence", () => {
    const t = fakeTimers(); const hub = new RoomHub(LIMITS, t);
    const a = sink("A"), b = sink("B");
    hub.join(a, 1, DOC, { userId: "u1", canPublish: true }); hub.setPresence(a, 1, { x: 1 });
    hub.join(b, 1, DOC, { userId: "u2", canPublish: true });
    t.advance(30);
    const memberId = (b.frames.find((f) => f.type === "RoomSync") as v1.RoomSync).members[0]!.memberId;
    b.frames.length = 0;
    hub.detach(a);
    t.advance(4000);
    const a2 = sink("A"); // the same protocol session on a new socket
    hub.join(a2, 1, DOC, { userId: "u1", canPublish: true });
    t.advance(2000);
    expect(b.frames).toEqual([]);
    expect((last(a2) as v1.RoomSync).self).toBe(memberId);
    expect(hub.members(DOC).find((m) => m.memberId === memberId)?.presence).toEqual({ x: 1 });
  });
  test("past it the member leaves", () => {
    const t = fakeTimers(); const hub = new RoomHub(LIMITS, t);
    const a = sink("A"), b = sink("B");
    hub.join(a, 1, DOC, { userId: null, canPublish: true }); hub.join(b, 1, DOC, { userId: null, canPublish: true });
    t.advance(30); b.frames.length = 0;
    hub.detach(a); t.advance(5000 + 30);
    expect(last(b)).toMatchObject({ type: "RoomMembers", left: [expect.any(String)] });
    expect(hub.size).toEqual({ rooms: 1, members: 1 });
  });
  test("a room with no member left is gone: memory returns to its baseline", () => {
    const t = fakeTimers(); const hub = new RoomHub(LIMITS, t);
    for (let i = 0; i < 100; i++) { const s = sink(`S${i}`); hub.join(s, 1, { ...DOC, argsJson: `{"i":${i}}` }, { userId: null, canPublish: true }); hub.leave(s, 1); }
    t.advance(30);
    expect(hub.size).toEqual({ rooms: 0, members: 0 });
  });
});

describe("presence scopes", () => {
  test("three tabs of one user are one member, who leaves only after the last tab's grace", () => {
    const t = fakeTimers(); const hub = new RoomHub(LIMITS, t);
    const tabs = [sink("T1"), sink("T2"), sink("T3")], other = sink("O");
    for (const s of tabs) hub.join(s, 1, ONLINE, { userId: "u1", canPublish: true });
    hub.join(other, 1, ONLINE, { userId: "u2", canPublish: true });
    expect((last(other) as v1.RoomSync).members).toEqual([{ memberId: "u1", userId: "u1", presence: null, idle: false }]);
    t.advance(30); other.frames.length = 0;
    hub.detach(tabs[0]!); hub.leave(tabs[1]!, 1); t.advance(6000);
    expect(other.frames).toEqual([]);
    hub.detach(tabs[2]!); t.advance(5000 + 30);
    expect(last(other)).toMatchObject({ type: "RoomMembers", left: ["u1"] });
  });
  test("the last write from any tab is the user's state; idle only when every tab is idle", () => {
    const t = fakeTimers(); const hub = new RoomHub(LIMITS, t);
    const t1 = sink("T1"), t2 = sink("T2"), other = sink("O");
    hub.join(t1, 1, ONLINE, { userId: "u1", canPublish: true }); hub.join(t2, 1, ONLINE, { userId: "u1", canPublish: true });
    hub.join(other, 1, ONLINE, { userId: "u2", canPublish: true });
    hub.setPresence(t1, 1, { name: "A" }, true); hub.setPresence(t2, 1, { name: "B" }, false);
    t.advance(30);
    expect(hub.members(ONLINE).find((m) => m.userId === "u1")).toEqual({ memberId: "u1", userId: "u1", presence: { name: "B" }, idle: false });
    hub.setPresence(t2, 1, { name: "B" }, true); t.advance(30);
    expect(hub.members(ONLINE).find((m) => m.userId === "u1")?.idle).toBe(true);
  });
});

describe("backpressure", () => {
  test("a client too far behind is closed for a resync, never sent a partial membership", () => {
    const t = fakeTimers(); const hub = new RoomHub({ ...LIMITS, maxBufferedBytes: 100 }, t);
    const a = sink("A"), slow = sink("S");
    hub.join(slow, 1, DOC, { userId: null, canPublish: true });
    slow.queued = 1000; slow.frames.length = 0;
    hub.join(a, 1, DOC, { userId: null, canPublish: true }); t.advance(30);
    expect(slow.resyncs).toBe(1);
    expect(slow.frames).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/server/test/rooms-hub.test.ts`. Expected: FAIL (the module does not exist).

- [ ] **Step 3: Implement `limits.ts`**

```ts
// packages/server/src/rooms/limits.ts
// The rooms' limits (STUDY-164 §3.5, R6), each a knob (STUDY-147).
import { knob, type KnobEnv, secondsKnob } from "@bunvex/core";

export type RoomLimits = {
  payloadBytes: number; argsBytes: number; roomsPerConnection: number; presencePerSecond: number;
  eventsPerSecond: number; memberCap: number; graceMs: number; tickMs: number; maxBufferedBytes: number;
};
export function roomLimitsFromEnv(env: KnobEnv = process.env): RoomLimits {
  return {
    payloadBytes: knob("ROOM_PAYLOAD_MAX_BYTES", 4096, "positive", env),
    argsBytes: knob("ROOM_ARGS_MAX_BYTES", 4096, "positive", env),
    roomsPerConnection: knob("ROOMS_PER_CONNECTION", 64, "positive", env),
    presencePerSecond: knob("ROOM_PRESENCE_PER_SECOND", 40, "positive", env),
    eventsPerSecond: knob("ROOM_EVENTS_PER_SECOND", 10, "positive", env),
    memberCap: knob("ROOM_MEMBER_CAP", 500, "positive", env),
    graceMs: secondsKnob("ROOM_RECONNECT_GRACE_SECS", 5, env),
    tickMs: knob("ROOM_TICK_MS", 30, "positive", env),
    maxBufferedBytes: knob("ROOM_MAX_BUFFERED_BYTES", 1 << 20, "positive", env),
  };
}
```

- [ ] **Step 4: Implement `hub.ts`**

The data model: a `Room` keeps its key, its members and a pending set and left list for the next tick.
- **A room's members** are keyed by `memberKey = sessionId` (one per connection).
- **A scope's members** are keyed by `userId`. Each scope member holds a set of `Attachment`s (one per tab), and
  each attachment has its own `idle` flag.
- **Every attachment** records `{ sink, roomId, room, buckets }`.
- **Two indexes** connect them: `bySink: Map<RoomSink, Map<roomId, Attachment>>`, and
  `graced: Map<string, Attachment>`, keyed `${sessionId}|${roomKeyString}`, with a timer.

```ts
// packages/server/src/rooms/hub.ts
// The rooms' members, in memory (AD-42, STUDY-164 §3.5): who is in which room, their presence, the reconnect
// grace, the per-member rate buckets and the member cap. Presence is coalesced: each tick sends one RoomMembers
// frame per member with the latest of every change since the last. Membership frames are never dropped; a
// connection too far behind is closed instead, and rejoins on reconnect.
import { randomUUID } from "node:crypto";
import type { JSONValue, v1 } from "@bunvex/protocol";
import type { RoomLimits } from "./limits.ts";

export type Timers = { now(): number; set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
const realTimers: Timers = {
  now: () => performance.now(),
  set: (fn, ms) => { const h = setTimeout(fn, ms); (h as { unref?: () => void }).unref?.(); return h; },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
export interface RoomSink { readonly sessionId: string; send(frame: v1.ServerMessage): void; behind(): number; resync(): void }
export type RoomKey = { kind: v1.RoomKind; name: string; argsJson: string };
export const roomKeyString = (k: RoomKey) => `${k.kind}|${k.name}|${k.argsJson}`;

/** A token bucket: `perSecond` tokens, refilled continuously. */
class Bucket {
  private tokens: number; private at: number;
  constructor(private readonly perSecond: number, now: number) { this.tokens = perSecond; this.at = now; }
  take(now: number): boolean {
    this.tokens = Math.min(this.perSecond, this.tokens + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
type Member = { memberId: string; userId: string | null; presence: JSONValue | null; attachments: Set<Attachment> };
type Attachment = {
  sink: RoomSink; roomId: number; room: Room; member: Member; canPublish: boolean; idle: boolean;
  presenceBucket: Bucket; eventBucket: Bucket; grace: unknown | null;
};
type Room = { key: RoomKey; members: Map<string, Member>; changed: Set<Member>; left: string[] };

export class RoomHub {
  private readonly rooms = new Map<string, Room>();
  private readonly bySink = new Map<RoomSink, Map<number, Attachment>>();
  private readonly graced = new Map<string, Attachment>();
  private tick: unknown | null = null;

  constructor(private readonly limits: RoomLimits, private readonly timers: Timers = realTimers) {}

  get size() {
    let members = 0;
    for (const r of this.rooms.values()) members += r.members.size;
    return { rooms: this.rooms.size, members };
  }

  join(sink: RoomSink, roomId: number, key: RoomKey, who: { userId: string | null; canPublish: boolean }): "ok" | "limit" {
    const ks = roomKeyString(key);
    const mine = this.bySink.get(sink) ?? new Map<number, Attachment>();
    if (!mine.has(roomId) && mine.size >= this.limits.roomsPerConnection) return "limit";
    const kept = this.graced.get(`${sink.sessionId}|${ks}`);
    if (kept && kept.member.userId === who.userId) {
      // A reconnect within the grace: the same member, moved to the new socket; the others see nothing.
      this.timers.clear(kept.grace);
      this.graced.delete(`${sink.sessionId}|${ks}`);
      kept.grace = null;
      kept.sink = sink; kept.roomId = roomId; kept.canPublish = who.canPublish;
      mine.set(roomId, kept); this.bySink.set(sink, mine);
      this.sendSync(kept);
      return "ok";
    }
    let room = this.rooms.get(ks);
    const memberKey = key.kind === "presence" ? who.userId! : sink.sessionId;
    const existing = room?.members.get(memberKey);
    if (!existing && (room?.members.size ?? 0) >= this.limits.memberCap) return "limit";
    if (!room) {
      room = { key, members: new Map(), changed: new Set(), left: [] };
      this.rooms.set(ks, room);
    }
    const member: Member = existing ?? {
      memberId: key.kind === "presence" ? who.userId! : randomUUID(),
      userId: who.userId, presence: null, attachments: new Set(),
    };
    const now = this.timers.now();
    const a: Attachment = {
      sink, roomId, room, member, canPublish: who.canPublish, idle: false, grace: null,
      presenceBucket: new Bucket(this.limits.presencePerSecond, now), eventBucket: new Bucket(this.limits.eventsPerSecond, now),
    };
    member.attachments.add(a);
    mine.set(roomId, a); this.bySink.set(sink, mine);
    if (!existing) { room.members.set(memberKey, member); room.changed.add(member); this.scheduleTick(); }
    else if (room.key.kind === "presence") { room.changed.add(member); this.scheduleTick(); } // idle may change
    this.sendSync(a);
    return "ok";
  }

  leave(sink: RoomSink, roomId: number) {
    const a = this.bySink.get(sink)?.get(roomId);
    if (!a) return;
    this.bySink.get(sink)!.delete(roomId);
    this.detachOne(a);
  }

  /** The connection closed: each of its memberships is kept for the grace, then leaves. */
  detach(sink: RoomSink) {
    const mine = this.bySink.get(sink);
    if (!mine) return;
    this.bySink.delete(sink);
    for (const a of mine.values()) {
      const gk = `${sink.sessionId}|${roomKeyString(a.room.key)}`;
      this.graced.set(gk, a);
      a.grace = this.timers.set(() => {
        if (this.graced.get(gk) !== a) return;
        this.graced.delete(gk);
        this.detachOne(a);
      }, this.limits.graceMs);
    }
  }

  setPresence(sink: RoomSink, roomId: number, presence: JSONValue, idle?: boolean): "ok" | "forbidden" | "rate_limited" {
    const a = this.bySink.get(sink)?.get(roomId);
    if (!a || !a.canPublish) return "forbidden";
    if (!a.presenceBucket.take(this.timers.now())) return "rate_limited";
    a.member.presence = presence;
    if (idle !== undefined) a.idle = idle;
    a.room.changed.add(a.member);
    this.scheduleTick();
    return "ok";
  }

  event(sink: RoomSink, roomId: number, event: string, data: JSONValue): "ok" | "forbidden" | "rate_limited" {
    const a = this.bySink.get(sink)?.get(roomId);
    if (!a || !a.canPublish || a.room.key.kind !== "room") return "forbidden";
    if (!a.eventBucket.take(this.timers.now())) return "rate_limited";
    this.fanOutEvent(a.room, a.member.memberId, event, data, a);
    return "ok";
  }

  broadcast(key: RoomKey, event: string, data: JSONValue) {
    const room = this.rooms.get(roomKeyString(key));
    if (room && room.key.kind === "room") this.fanOutEvent(room, null, event, data, null);
  }

  members(key: RoomKey): v1.RoomMember[] {
    const room = this.rooms.get(roomKeyString(key));
    return room ? [...room.members.values()].map((m) => this.view(room, m)) : [];
  }

  roomsOf(sink: RoomSink) {
    return [...(this.bySink.get(sink)?.values() ?? [])].map((a) => ({ roomId: a.roomId, key: a.room.key }));
  }

  setCanPublish(sink: RoomSink, roomId: number, canPublish: boolean) {
    const a = this.bySink.get(sink)?.get(roomId);
    if (a) a.canPublish = canPublish;
  }

  private detachOne(a: Attachment) {
    const { room, member } = a;
    member.attachments.delete(a);
    if (member.attachments.size > 0) { room.changed.add(member); this.scheduleTick(); return; } // a scope's other tab
    const memberKey = room.key.kind === "presence" ? member.userId! : a.sink.sessionId;
    room.members.delete(memberKey);
    room.changed.delete(member);
    room.left.push(member.memberId);
    this.scheduleTick();
  }

  private view(room: Room, m: Member): v1.RoomMember {
    if (room.key.kind === "room") return { memberId: m.memberId, userId: m.userId, presence: m.presence };
    const idle = m.attachments.size > 0 && [...m.attachments].every((x) => x.idle);
    return { memberId: m.memberId, userId: m.userId, presence: m.presence, idle };
  }

  private sendSync(a: Attachment) {
    const others = [...a.room.members.values()].filter((m) => m !== a.member).map((m) => this.view(a.room, m));
    this.deliver(a.sink, { type: "RoomSync", roomId: a.roomId, self: a.member.memberId, canPublish: a.canPublish, members: others });
  }

  private fanOutEvent(room: Room, from: string | null, event: string, data: JSONValue, sender: Attachment | null) {
    for (const m of room.members.values())
      for (const x of m.attachments)
        if (x !== sender && x.grace === null && !(sender && x.member === sender.member))
          this.deliver(x.sink, { type: "RoomEvent", roomId: x.roomId, from, event, data });
  }

  private scheduleTick() {
    if (this.tick !== null) return;
    this.tick = this.timers.set(() => { this.tick = null; this.flush(); }, this.limits.tickMs);
  }

  /** One coalesced RoomMembers frame per attached member of every changed room. */
  private flush() {
    for (const [ks, room] of this.rooms) {
      if (room.changed.size === 0 && room.left.length === 0) {
        if (room.members.size === 0) this.rooms.delete(ks);
        continue;
      }
      const changed = [...room.changed]; const left = room.left;
      room.changed = new Set(); room.left = [];
      for (const m of room.members.values())
        for (const x of m.attachments) {
          if (x.grace !== null) continue;
          const set = changed.filter((c) => c !== m).map((c) => this.view(room, c));
          if (set.length || left.length) this.deliver(x.sink, { type: "RoomMembers", roomId: x.roomId, set, left });
        }
      if (room.members.size === 0) this.rooms.delete(ks);
    }
  }

  /** Membership frames are never dropped: a connection too far behind is closed, and re-syncs on reconnect. */
  private deliver(sink: RoomSink, frame: v1.ServerMessage) {
    if (sink.behind() > this.limits.maxBufferedBytes) { sink.resync(); return; }
    sink.send(frame);
  }
}
```

A resynced sink is detached by its session's close, which goes through the grace like any close. Its reconnect
gets a full `RoomSync`, so whatever frames it missed do not matter.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/server/test/rooms-hub.test.ts`. Expected: PASS. Fix the hub, not the tests, if one
fails. The tests are the spec's rules.

- [ ] **Step 6: Sabotage each rule, then commit**

Each of these must fail at least one test. Restore after each:
- remove the `graced` lookup in `join`;
- send presence at once instead of in `flush`;
- skip the cap check;
- in `detachOne`, delete the scope member while other attachments remain;
- make `deliver` drop the frame instead of calling `resync`;
- never delete empty rooms.

```bash
git add packages/server/src/rooms packages/server/test/rooms-hub.test.ts
git commit -m "feat(server): RoomHub, rooms and presence scopes in memory (AD-42, STUDY-164 §3.5)"
```

---

### Task 4: `Tx.afterCommit` — side effects after a successful commit

Broadcasts from mutations ride on this. It is generic: a callback registered by the transaction runs after the
commit succeeds. It is dropped when the attempt fails, is retried, or is rolled back to a savepoint taken before
it.

> Coordinate first: the components session is editing `packages/core/src/tx.ts` and `engine.ts` (STUDY-153).
> Branch from the latest main, and tell it which functions you touch (`begin`, `rollback`, a new field, and
> `Engine.runMutation`).

**Files:**
- Modify: `packages/core/src/tx.ts`:
  - a field on `Tx` (class at :442);
  - `begin()` (:1941) and the `Savepoint` type;
  - `rollback()` (:1957).
- Modify: `packages/core/src/engine.ts`, `runMutation` (3817-): run the callbacks after `committer.commit`
  resolves, and in the `!tx.hasWrites` early return.
- Test: `packages/core/test/after-commit.test.ts`

**Interfaces:**
- Produces: `Tx.afterCommit(fn: () => void): void`. Callbacks run in registration order, after the commit, once.
  A throwing callback is logged (`console.error("bunvex: an after-commit callback failed: …")`) and does not fail
  the mutation.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/after-commit.test.ts
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { defineSchema, defineTable, Engine } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";

const open = async () =>
  new Engine(defineSchema({ t: defineTable(v.any()) }), await MemoryPersistence.open(null, { durable: false })).init();

describe("Tx.afterCommit", () => {
  test("runs after the commit, once, in order", async () => {
    const e = await open(); const seen: string[] = [];
    await e.mutation(async (db) => {
      db.afterCommit(() => seen.push("a"));
      await db.insert("t", {});
      db.afterCommit(() => seen.push("b"));
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual(["a", "b"]);
  });
  test("runs for a mutation with no writes too", async () => {
    const e = await open(); const seen: string[] = [];
    await e.mutation(async (db) => void db.afterCommit(() => seen.push("x")));
    expect(seen).toEqual(["x"]);
  });
  test("never runs for a mutation that throws", async () => {
    const e = await open(); const seen: string[] = [];
    await e.mutation(async (db) => { db.afterCommit(() => seen.push("x")); throw new Error("no"); }).catch(() => {});
    expect(seen).toEqual([]);
  });
  test("an OCC retry drops the failed attempt's callbacks", async () => {
    const e = await open(); const seen: number[] = []; let attempt = 0;
    const id = await e.mutation((db) => db.insert("t", { n: 0 }));
    await e.mutation(async (db) => {
      const n = ++attempt;
      db.afterCommit(() => seen.push(n));
      await db.get(id);
      if (n === 1) await e.mutation((db2) => db2.patch(id, { n: 1 })); // conflicts with this attempt's read
      await db.patch(id, { n: 2 });
    });
    expect(attempt).toBe(2);
    expect(seen).toEqual([2]);
  });
  test("a rollback to a savepoint drops what was registered after it", async () => {
    const e = await open(); const seen: string[] = [];
    await e.mutation(async (db) => {
      db.afterCommit(() => seen.push("kept"));
      const sp = db.begin();
      db.afterCommit(() => seen.push("dropped"));
      db.rollback(sp);
    });
    expect(seen).toEqual(["kept"]);
  });
  test("a throwing callback is logged and does not fail the mutation", async () => {
    const e = await open(); const errs: string[] = []; const real = console.error;
    console.error = (...a: unknown[]) => errs.push(a.join(" "));
    try {
      expect(await e.mutation(async (db) => { db.afterCommit(() => { throw new Error("boom"); }); return 1; })).toBe(1);
    } finally { console.error = real; }
    expect(errs).toEqual([expect.stringContaining("boom")]);
  });
});
```

If `Engine.mutation`'s OCC path does not conflict in the shape above, check how
`packages/core/test/occ.test.ts` forces a conflict and use that.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/core/test/after-commit.test.ts`. Expected: FAIL (`db.afterCommit` is not a function).

- [ ] **Step 3: Implement**

In `tx.ts`:

```ts
  /** Callbacks to run once this transaction has committed (STUDY-164 §3.4: a mutation's broadcasts). */
  afterCommitCallbacks: (() => void)[] = [];
  afterCommit(fn: () => void) {
    this.afterCommitCallbacks.push(fn);
  }
```

- In `begin()`, add `afterCommit: this.afterCommitCallbacks.length` to the savepoint (and to the `Savepoint`
  type).
- In `rollback(sp)`, add `this.afterCommitCallbacks.length = sp.afterCommit;`.

In `engine.ts`, add a helper:

```ts
function runAfterCommit(tx: Tx) {
  for (const fn of tx.afterCommitCallbacks)
    try {
      fn();
    } catch (e) {
      console.error(`bunvex: an after-commit callback failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
```

- Call it in `runMutation` right before `return` in the `!tx.hasWrites` branch.
- Call it after `const ts = await this.committer.commit(pending);` and the created-tables bookkeeping that
  follows, before the value is returned.
- A failed commit throws before the call, and its retry runs `this.execute` again, which makes a fresh `Tx`. So a
  failed attempt's callbacks are dropped with its `Tx`.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/core/test/after-commit.test.ts packages/core/test/occ.test.ts packages/core/test/savepoint*.test.ts`.
Expected: PASS.

- [ ] **Step 5: Measure, sabotage, commit**

- **Performance:** the commit path changes. Run `bun bench/commit.ts` (or whichever micro-benchmark of commits
  `bench/` has; see `bench/README.md`) before and after. Paste both numbers in the PR. The expected cost is an
  empty-array check per mutation.
- **Sabotage 1:** in `rollback`, do not truncate. The savepoint test fails.
- **Sabotage 2:** run the callbacks before `committer.commit`. The OCC test fails (`[1, 2]`).
- Run Stryker on the touched lines if the coverage-floor job asks for it. Mark equivalents with directives as the
  test-hardening notes describe.

```bash
git add packages/core
git commit -m "feat(core): Tx.afterCommit, side effects run once a mutation has committed"
```

---

### Task 5: Wire rooms into `SyncSession`

**Files:**
- Create: `packages/server/src/rooms/session.ts`
- Modify: `packages/server/src/sync.ts`:
  - `SyncSession` fields (917-946);
  - `handle()`: replace the Task 1 placeholder (1218-1300) and update `Authenticate` (1257-1296);
  - `close()` (975-984).
- Modify: `packages/server/src/server.ts`. Create one `RoomHub` in `createServer`, next to `SyncHub` (938-972),
  pass it to `SyncDeps` (`sync.ts:224-262`), and expose `functions.roomHub = hub` (used by Task 6).
- Test: `packages/server/test/rooms-sync.test.ts`

**Interfaces:**
- Consumes: Task 1 messages, Task 2 `Functions.roomDef(name)` and `AnyRoomDef`, Task 3 `RoomHub`, `RoomSink`,
  `RoomKey`.
- Produces:
  ```ts
  export class RoomConnection implements RoomSink {
    constructor(deps: { hub: RoomHub; functions: Functions; limits: RoomLimits; fromWire: (a: JSONValue) => Value }, io: {
      sessionId(): string; send(frame: v1.ServerMessage): void; buffered(): number; close(reason: string): void; caller(): Caller;
    });
    readonly sessionId: string;   // getter → io.sessionId()
    handle(m: v1.RoomJoin | v1.RoomLeave | v1.RoomPresence | v1.RoomClientEvent): Promise<void>;
    identityChanged(): Promise<void>;   // re-run gates for every room; leave those now refused
    closed(): void;                     // hub.detach(this)
  }
  ```
  `SyncSession` owns one `RoomConnection`, created lazily on the first room message so that a connection with no
  rooms costs nothing.

- [ ] **Step 1: Write the failing tests**

Use `packages/server/test/v1-client.ts` (`v1Client(url, sessionId)`) and the `setup()` of `sync.test.ts` (17-63).
Register the room definitions with `functions.register("rooms", { doc, online, secret })` (Task 2 allows it).

```ts
// packages/server/test/rooms-sync.test.ts — the cases (write each as its own test)
// - two clients join rooms:doc {id:"a"}: each gets RoomSync, and the second appears in the first's next RoomMembers
// - RoomPresence from A reaches B as RoomMembers.set with A's presence; never echoes to A
// - RoomEvent from A reaches B with from = A's memberId; an undeclared event name → RoomError validation, nothing sent
// - a presence that fails the validator → RoomError validation (message from checkValue), nothing sent
// - a payload over 4 KB → RoomError limit
// - canJoin false → RoomError no_access "You cannot join this room."; canJoin throws → the same message, no internals
// - canPublish false → RoomSync.canPublish false; RoomPresence → RoomError forbidden
// - an unknown room name → RoomError not_found; a room name joined with kind "presence" → not_found
// - a presence scope refuses an anonymous connection (no_access) whatever canJoin says
// - Authenticate to a user canJoin refuses → RoomError no_access for that room, and the others see it leave
// - the socket closes while canJoin is awaiting (a gate that waits on a promise the test releases after close):
//   no member is inserted (hub.size stays 0)
// - a reconnect with the same sessionId within the grace, rejoining: B sees no RoomMembers at all
// - a connection that never sends a room message receives no room frame, and hub.size is untouched
```

Write the gate-race test this way. The gate awaits a promise the test controls. The test sends `RoomJoin`, closes
the socket, releases the gate, waits for the session's inbox to drain, then expects
`server.rooms.size.members === 0`.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/server/test/rooms-sync.test.ts`. Expected: FAIL (room messages are ignored).

- [ ] **Step 3: Implement `RoomConnection`**

```ts
// packages/server/src/rooms/session.ts
// One connection's rooms (STUDY-164 §3.4–3.6): the protocol messages to and from the hub, the gates run as
// queries with the connection's identity, and the validation of presence and events.
import { checkValue, type Value } from "@bunvex/values";
import type { JSONValue, v1 } from "@bunvex/protocol";
// …imports of Functions, Caller, RoomHub, RoomLimits, AnyRoomDef, roomKeyString

const NO_ACCESS = "You cannot join this room.";
const SIGNED_IN = "A presence scope is for signed-in users.";

export class RoomConnection {
  private joined = new Map<number, { def: AnyRoomDef; key: RoomKey; args: Value; userId: string | null }>();
  private closedFlag = false;
  private warnedAt = 0;
  constructor(private readonly deps: Deps, private readonly io: Io) {}
  get sessionId() { return this.io.sessionId(); }
  send(f: v1.ServerMessage) { this.io.send(f); }
  behind() { return this.io.buffered(); }
  resync() { this.io.close("room frames too far behind"); }

  async handle(m: RoomMessage) {
    switch (m.type) {
      case "RoomJoin": return this.join(m);
      case "RoomLeave": this.joined.delete(m.roomId); this.deps.hub.leave(this, m.roomId); return;
      case "RoomPresence": return this.presence(m);
      case "RoomEvent": return this.event(m);
    }
  }

  private error(roomId: number, code: v1.RoomErrorCode, message: string) {
    this.send({ type: "RoomError", roomId, code, message });
  }
  private size = (x: JSONValue) => Buffer.byteLength(JSON.stringify(x));

  private async join(m: v1.RoomJoin) {
    const def = this.deps.functions.roomDef(m.name);
    if (!def || def.kind !== m.kind) return this.error(m.roomId, "not_found", `No ${m.kind} named "${m.name}".`);
    if (this.size(m.args) > this.deps.limits.argsBytes) return this.error(m.roomId, "limit", "The room's arguments are too large.");
    const args = this.deps.fromWire(m.args);
    if (def.args) {
      const why = checkValue(def.args, args);
      if (why) return this.error(m.roomId, "validation", why);
    }
    const caller = this.io.caller();
    const userId = caller.identity?.subject ?? null;
    if (def.kind === "presence" && userId === null) return this.error(m.roomId, "no_access", SIGNED_IN);
    const allowed = await this.gate(def.canJoin, m.name, args, caller);
    // The socket may have closed while the gate ran: inserting now would leave a member no one removes.
    if (this.closedFlag) return;
    if (!allowed) return this.error(m.roomId, "no_access", NO_ACCESS);
    const canPublish = def.kind === "presence" ? true : await this.gate(def.canPublish, m.name, args, caller);
    if (this.closedFlag) return;
    const key: RoomKey = { kind: def.kind, name: m.name, argsJson: canonicalJson(m.args) };
    if (this.deps.hub.join(this, m.roomId, key, { userId, canPublish }) === "limit")
      return this.error(m.roomId, "limit", "This room is full, or this connection is in too many rooms.");
    this.joined.set(m.roomId, { def, key, args, userId });
  }

  /** A gate: absent is "yes"; it runs as a query with the caller's identity; a throw is "no", with no internals. */
  private async gate(g: RoomGate | undefined, name: string, args: Value, caller: Caller): Promise<boolean> {
    if (!g) return true;
    try {
      return (await this.deps.functions.runGate(g, name, args, caller)) === true;
    } catch {
      return false;
    }
  }

  private presence(m: v1.RoomPresence) {
    const j = this.joined.get(m.roomId);
    if (!j) return this.error(m.roomId, "not_found", "Not in this room.");
    if (this.size(m.presence) > this.deps.limits.payloadBytes) return this.error(m.roomId, "limit", "The presence is too large.");
    const why = checkValue(j.def.kind === "room" ? j.def.presence : j.def.state, this.deps.fromWire(m.presence));
    if (why) return this.error(m.roomId, "validation", why);
    this.report(m.roomId, this.deps.hub.setPresence(this, m.roomId, m.presence, m.idle));
  }

  private event(m: v1.RoomClientEvent) {
    const j = this.joined.get(m.roomId);
    if (!j || j.def.kind !== "room") return this.error(m.roomId, "not_found", "Not in this room.");
    const validator = j.def.events[m.event];
    if (!validator) return this.error(m.roomId, "validation", `This room has no event "${m.event}".`);
    if (this.size(m.data) > this.deps.limits.payloadBytes) return this.error(m.roomId, "limit", "The event is too large.");
    const why = checkValue(validator, this.deps.fromWire(m.data));
    if (why) return this.error(m.roomId, "validation", why);
    this.report(m.roomId, this.deps.hub.event(this, m.roomId, m.event, m.data));
  }

  /** forbidden is reported each time; rate_limited at most once a second (the excess is dropped). */
  private report(roomId: number, r: "ok" | "forbidden" | "rate_limited") {
    if (r === "forbidden") this.error(roomId, "forbidden", "This connection may not publish in this room.");
    if (r === "rate_limited" && performance.now() - this.warnedAt >= 1000) {
      this.warnedAt = performance.now();
      this.error(roomId, "rate_limited", "Too many updates: some were dropped.");
    }
  }

  async identityChanged() {
    const caller = this.io.caller();
    const userId = caller.identity?.subject ?? null;
    for (const [roomId, j] of [...this.joined]) {
      const ok = (j.def.kind !== "presence" || userId !== null) && (await this.gate(j.def.canJoin, j.key.name, j.args, caller));
      if (this.closedFlag) return;
      if (!ok || userId !== j.userId) {
        // A different user is a different member: leave, and rejoin when allowed.
        this.deps.hub.leave(this, roomId); this.joined.delete(roomId);
        if (!ok) { this.error(roomId, "no_access", NO_ACCESS); continue; }
        if (this.deps.hub.join(this, roomId, j.key, { userId, canPublish: j.def.kind === "presence" || (await this.gate(j.def.canPublish, j.key.name, j.args, caller)) }) === "ok")
          this.joined.set(roomId, { ...j, userId });
        continue;
      }
      if (j.def.kind === "room") this.deps.hub.setCanPublish(this, roomId, await this.gate(j.def.canPublish, j.key.name, j.args, caller));
    }
  }

  closed() {
    this.closedFlag = true;
    this.deps.hub.detach(this);
  }
}
```

- `canonicalJson`: sort object keys recursively, then call `JSON.stringify`. Put it in `rooms/session.ts` unless
  one exists already. Grep `canonical` in `packages/server/src`, and reuse what the query cache key uses if it fits.
- `Functions.runGate(gate, name, args, caller)` in `functions.ts` builds a `QueryDef` from the gate:
  `query({ handler: (ctx, a) => gate(ctx, a) })` with no args validator, since the args were checked already.
  Run it through `runStandaloneQueryJson`'s path (2150-2160) without the JSON conversion: no cache, logged as
  `name`, with a query's ctx and `caller`'s identity. Return the handler's value.

In `sync.ts`:
- Add a field to `SyncSession`: `private rooms: RoomConnection | null = null`, and a getter `roomConn()` that
  creates it with `io = { sessionId: () => this.sessionId ?? this.connectionId, send: (f) => this.send(encodeServerMessage(f)), buffered: () => this.ws?.getBufferedAmount() ?? 0, close: (r) => this.fail(...), caller: () => this.currentCaller() }`.
  - If a `connectionId` (a random uuid) does not exist, add it for sessions with no `Connect`.
  - For `close`, use the existing close path, so the client reconnects: `ws.close(1011, reason)`, the same way
    `internalError` closes.
- In `handle`, replace the Task 1 placeholder: `case "RoomJoin": … return this.roomConn().handle(m);` for all four.
- In `Authenticate` (1257-1296), after the caller is set, call `await this.rooms?.identityChanged();`.
- In `close()` (975-984), call `this.rooms?.closed();`.
- Messages go through `this.inbox` already (1127-1140), so room messages are ordered with the rest of the
  session's.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/server/test/rooms-sync.test.ts packages/server/test/sync.test.ts`. Expected: PASS.

- [ ] **Step 5: Sabotage, then commit**

Each of these must fail a test. Restore after each:
- remove the `closedFlag` check after the gate (the gate-race test fails);
- return the gate's error message instead of `NO_ACCESS` (the no-internals test fails);
- skip `identityChanged` in `Authenticate`;
- skip the validator check on presence.

```bash
git add packages/server
git commit -m "feat(server): rooms over the sync protocol: join with gates, presence, events, identity changes (AD-42)"
```

---

### Task 6: `ctx.rooms` and `ctx.presence` in mutations and actions

**Files:**
- Create: `packages/server/src/rooms/ctx.ts`
- Modify: `packages/server/src/functions.ts`:
  - the mutation ctx in `invoke` (1660-1688), to add `rooms`;
  - `actionCtx` (2320-2425), to add `rooms` and `presence`;
  - a `roomHub: RoomHub | null = null` field.
- Modify: the `GenericMutationCtx` and `GenericActionCtx` types in `registration.ts`.
- Test: `packages/server/test/rooms-ctx.test.ts`

**Interfaces:**
- Consumes: Task 4 `Tx.afterCommit`, Task 3 `RoomHub.broadcast` and `members`, Task 2 `roomDef`.
- Produces:
  - `ctx.rooms.broadcast(ref, args, event, data): Promise<void>` in mutations and actions.
  - `ctx.rooms.members(ref, args): Promise<{ memberId: string; userId: string | null; presence: unknown }[]>` in
    actions only.
  - `ctx.presence.list(ref, args): Promise<{ userId: string; state: unknown; idle: boolean }[]>` in actions only.
  - Queries get neither `ctx.rooms` nor `ctx.presence`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/test/rooms-ctx.test.ts — cases
// - a mutation broadcasts: a member (v1Client in the room) gets RoomEvent with from = null only after the mutation
//   resolved; the event's data passed the event's validator
// - a mutation that broadcasts then throws: nothing is sent
// - a mutation retried by OCC (force a conflict as occ.test.ts does): exactly one RoomEvent
// - a nested ctx.runMutation that broadcasts then throws, caught by the parent: nothing sent from the nested one,
//   the parent's own broadcast is sent
// - an undeclared event or invalid data throws in the mutation (ArgumentValidationError-style message), nothing sent
// - an action broadcasts at once
// - an action reads members (two clients joined) and a presence scope's list (one user, two tabs → one entry)
// - a query has no ctx.rooms (typeof ctx.rooms === "undefined")
// - a broadcast to a room no one is in is a no-op
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/server/test/rooms-ctx.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/server/src/rooms/ctx.ts
// The server side of rooms (STUDY-164 §3.4): broadcast from mutations (after the commit) and actions; members
// read from actions only, so that queries and mutations stay functions of the database.
import { getFunctionName } from "@bunvex/protocol";
import { checkValue, toJsonValue, type Value } from "@bunvex/values";

export function roomsCtx(functions: Functions, onCommit: ((fn: () => void) => void) | null, canRead: boolean) {
  const resolve = (ref: unknown, kind: "room" | "presence", args: Value) => {
    const name = getFunctionName(ref as never);
    const def = functions.roomDef(name);
    if (!def || def.kind !== kind) throw new Error(`No ${kind} named "${name}".`);
    if (def.args) { const why = checkValue(def.args, args); if (why) throw new Error(why); }
    return { def, key: { kind, name, argsJson: canonicalJson(toJsonValue(args)) } };
  };
  const rooms = {
    async broadcast(ref: unknown, args: Value, event: string, data: Value) {
      const { def, key } = resolve(ref, "room", args);
      const validator = def.kind === "room" ? def.events[event] : undefined;
      if (!validator) throw new Error(`This room has no event "${event}".`);
      const why = checkValue(validator, data);
      if (why) throw new Error(why);
      const send = () => functions.roomHub?.broadcast(key, event, toJsonValue(data));
      if (onCommit) onCommit(send); else send();
    },
    ...(canRead
      ? { async members(ref: unknown, args: Value) {
            const { key } = resolve(ref, "room", args);
            return (functions.roomHub?.members(key) ?? []).map((m) => ({ memberId: m.memberId, userId: m.userId, presence: m.presence }));
          } }
      : {}),
  };
  const presence = canRead
    ? { async list(ref: unknown, args: Value) {
          const { key } = resolve(ref, "presence", args);
          return (functions.roomHub?.members(key) ?? []).map((m) => ({ userId: m.userId!, state: m.presence, idle: m.idle ?? false }));
        } }
    : undefined;
  return { rooms, presence };
}
```

- Mutation ctx in `invoke`: `rooms: roomsCtx(this, (fn) => db.afterCommit(fn), false).rooms`.
  - A nested `ctx.runMutation` uses the same `db` with a savepoint (1856-1867), so Task 4's rollback drops its
    broadcasts.
- Action ctx: `const r = roomsCtx(this, null, true); … rooms: r.rooms, presence: r.presence`, wrapped like the
  other ctx members, so that a cut-off action is refused (`cutOffWithAction`, as `scheduler` is at 2373-2381).
- Convert the presence values in `members` from wire JSON to values with `fromWire`/`parseValue`, so an action
  sees values, as from a query.

- [ ] **Step 4: Run, sabotage, commit**

Run: `bun test packages/server/test/rooms-ctx.test.ts`. Expected: PASS.

Sabotage: call `send()` directly in mutations. The throw, OCC and nested tests fail. Restore it.

```bash
git add packages/server
git commit -m "feat(server): ctx.rooms.broadcast after commit, members and presence lists in actions (AD-42)"
```

---

### Task 7: Client — `joinRoom` and `joinPresence`

**Files:**
- Create: `packages/client/src/rooms.ts`
- Modify: `packages/client/src/base-client.ts`:
  - `onOpen` (218-232): rejoin after `Connect` and before `state.restart()`;
  - `onMessage` (234-267): route the four room frames;
  - new public methods `joinRoom` and `joinPresence`.
- Modify: `packages/client/src/simple-client.ts` (expose via `.client`) and `packages/client/src/index.ts`
  (export the types).
- Test: `packages/sync-e2e/test/rooms.test.ts` (against a real server, `harness.ts` `startServer`), and
  `packages/client/test/rooms-throttle.test.ts` (unit, with a fake clock).

**Interfaces:**
- Consumes: Task 1 messages.
- Produces:
  ```ts
  export type RoomMemberView<P> = { memberId: string; userId: string | null; presence: P | null };
  export interface RoomHandle<P, E extends Record<string, unknown>> {
    readonly status: "joining" | "joined" | "error";
    readonly error: { code: string; message: string } | null;
    readonly self: string | null;
    readonly canPublish: boolean;
    others(): RoomMemberView<P>[];          // a stable array, replaced on change
    myPresence(): P | null;
    setPresence(p: P): void;                // throttled 50 ms, leading and trailing edge
    broadcast<K extends keyof E & string>(event: K, data: E[K]): void;
    on<K extends keyof E & string>(event: K, cb: (from: string | null, data: E[K]) => void): () => void;
    subscribe(cb: () => void): () => void;  // any change of status, others or canPublish
    leave(): void;
  }
  export interface PresenceHandle<S> {
    readonly status: "joining" | "joined" | "error"; readonly error: { code: string; message: string } | null;
    others(): { userId: string; state: S | null; idle: boolean }[];   // you left out
    count(): number;                                                   // you included
    setState(s: S): void;                                              // throttled
    setIdle(idle: boolean): void;
    subscribe(cb: () => void): () => void;
    leave(): void;
  }
  // BaseBunvexClient
  joinRoom(ref, args): RoomHandle<…>;
  joinPresence(ref, args): PresenceHandle<…>;
  ```
- Memberships are ref-counted by `(kind, name, canonical args)`. A second `joinRoom` with the same key returns a
  handle on the same membership. `leave()` from the last handle sends `RoomLeave`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/client/test/rooms-throttle.test.ts
// - setPresence 10 times within 50 ms sends 2 RoomPresence: the first at once, the last at 50 ms
// - setPresence once, then nothing: 1 message
// packages/sync-e2e/test/rooms.test.ts (two BunvexClient, harness.ts)
// - A and B join the same room: each sees the other in others(); A.setPresence reaches B
// - B.on("wave") receives A.broadcast("wave", …); A's own handler does not fire
// - two joinRoom on A with the same args → one member on the server (B sees one); leave one → B still sees A;
//   leave the second → B sees A leave
// - the server restarts (h.restart()) → the client reconnects and rejoins: B sees A again with A's last presence
// - a socket drop and reconnect within the grace (close A's socket from the server side): B sees no leave
// - RoomError no_access sets status "error" and error.code "no_access"; nothing is retried
// - joinPresence on two clients of the same user (setAuth with the same token) → B's others() has one entry
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/client/test/rooms-throttle.test.ts`, then (in `packages/sync-e2e`)
`bun test --preload ../../scripts/test-loopback.ts test/rooms.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `rooms.ts`**

`RoomManager`, constructed by `BaseBunvexClient` with `send(m: v1.ClientMessage): boolean`:
- **State:** `nextRoomId`; `byKey: Map<string, Membership>`; `byId: Map<number, Membership>`.
- **A `Membership`** holds `{ kind, name, argsJson, wireArgs, roomId, refs, status, error, self, canPublish, members: Map<memberId, RoomMember>, presence, idle, listeners: Set<() => void>, eventListeners: Map<event, Set<cb>>, othersCache }`.
- **`join(kind, name, args)`:** canonicalises the args with `convexToJson`'s bunvex equivalent (`toJsonValue`
  from `@bunvex/values`) plus key sorting. It reuses a membership with the same key or creates one with a new
  `roomId`, and sends `RoomJoin` when the socket is open. The handle's `leave()` decrements `refs`; at 0 it sends
  `RoomLeave` and deletes the membership.
- **`onOpen()`:** for every membership, set `status = "joining"`, assign a fresh `roomId` (the server's ids are
  per connection), re-send `RoomJoin`, and re-send the last presence and idle (a `RoomPresence`) right after.
- **`onMessage(m)`:**
  - `RoomSync` replaces `members` and sets `self`, `canPublish` and `status = "joined"`;
  - `RoomMembers` applies `set` and `left`;
  - `RoomEvent` calls the event's listeners with `(from, data)`;
  - `RoomError` sets `status = "error"` and `error`, unless the code is `rate_limited` or `forbidden`, which only
    log a warning (through the client's logger).
  - Each case notifies `listeners` and rebuilds `othersCache` only when members changed, so `others()` stays
    referentially stable for `useSyncExternalStore`.
- **Throttle:** `setPresence` stores the latest value. If no send happened in the last 50 ms it sends at once
  (leading edge). Otherwise it schedules one trailing send at `last + 50`. Inject `now`/`setTimeout` for the unit
  test.
- **Presence-scope views:** `others()` for a scope filters out `self`; `count()` is `members.size + 1`.

`BaseBunvexClient`:
- construct `this.rooms = new RoomManager((m) => this.webSocketManager.sendMessage(m), logger)`;
- in `onOpen`, after `Connect`, call `this.rooms.onOpen()`;
- in `onMessage`, add the cases `RoomSync | RoomMembers | RoomEvent | RoomError`, calling `this.rooms.onMessage(m)`;
- add `joinRoom(ref, args) { return this.rooms.joinRoom(getFunctionName(ref), args); }`, and `joinPresence`
  likewise.
- Add both to `BaseClientInterface`'s `Pick` in `packages/react/src/client.ts` (66-82).

- [ ] **Step 4: Run, sabotage, commit**

Run the two test files. Expected: PASS.

Each sabotage must fail a test:
- without the ref-count (every `join` sends `RoomJoin`);
- without the rejoin in `onOpen`;
- without the trailing send.

```bash
git add packages/client packages/sync-e2e/test/rooms.test.ts packages/react/src/client.ts
git commit -m "feat(client): joinRoom and joinPresence, ref-counted, rejoined on reconnect, presence throttled (AD-42)"
```

---

### Task 8: React — `useRoom` and `usePresence`

**Files:**
- Create: `packages/react/src/rooms.ts`
- Modify: `packages/react/src/index.ts` (exports)
- Test: `packages/sync-e2e/react/rooms.test.tsx` (pattern: `react.test.tsx:28-40`; run with the `test:react`
  script)

**Interfaces:**
- Consumes: Task 7 `RoomHandle`, `PresenceHandle`, and `useRequiredClient` (`context.ts:18-25`).
- Produces:
  ```ts
  export function useRoom<R extends RoomReference<"room", any, any, any>>(ref: R, args: R["_args"] | "skip"): {
    status: "joining" | "joined" | "error"; error: { code: string; message: string } | null;
    useOthers(): RoomMemberView<R["_presence"]>[];
    useMyPresence(): [R["_presence"] | null, (p: R["_presence"]) => void];
    useBroadcast<K extends keyof R["_events"] & string>(event: K): (data: R["_events"][K]) => void;
    useEvent<K extends keyof R["_events"] & string>(event: K, cb: (from: string | null, data: R["_events"][K]) => void): void;
  };
  export function usePresence<R extends RoomReference<"presence", any, any>>(ref: R, args: R["_args"] | "skip", opts?: { idleMs?: number }): {
    status: …; error: …; others: { userId: string; state: R["_presence"] | null; idle: boolean }[]; count: number;
    me: R["_presence"] | null; setMyState(s: R["_presence"]): void; isIdle: boolean;
  };
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
// packages/sync-e2e/react/rooms.test.tsx — cases
// - two mounted trees (two clients): <Cursors/> in each, useMyPresence setter in A → B's useOthers renders A's x
// - a component that only uses useEvent does NOT re-render when presence changes (count renders with a ref)
// - changing args (docId a → b) leaves a and joins b; for one frame it never shows a's members under b
//   (CLIENT-08's lesson: key the state by client and args)
// - "skip" joins nothing
// - unmount leaves (the other tree sees the member leave after the grace — use a short ROOM_RECONNECT_GRACE_SECS
//   in the harness for this test)
// - usePresence({idleMs: 50}) with no input for 60 ms → the other tree sees idle true; a keydown → idle false
// - usePresence with no window (React Native): no crash, idle never set, a single warning
```

- [ ] **Step 2: Run them to see them fail**

Run (in `packages/sync-e2e`): `bun run test:react -- rooms`. Expected: FAIL.

- [ ] **Step 3: Implement**

- **`useRoom`:**
  - Take the client via `useRequiredClient("useRoom")`.
  - Memoise `handle = client.sync.joinRoom(ref, args)` in an effect keyed by `[client, name, argsJson]`, leaving
    on cleanup. Store it in state together with that key, and render "joining" while the stored key differs from
    the current one, so a stale room's members never show under new args.
  - The sub-hooks are functions on a stable object (a `useMemo` on the handle). Each uses `useSyncExternalStore`
    on `handle.subscribe` with its own selector:
    - `useOthers` reads `handle.others()`;
    - `useMyPresence` reads `handle.myPresence()` and returns `handle.setPresence`;
    - `useBroadcast` returns a `useCallback` around `handle.broadcast`;
    - `useEvent` subscribes in a `useEffect` via `handle.on`, with the latest callback held in a ref.
  - Calling a hook through an object is fine for the rules of hooks as long as each component calls the same
    ones in the same order. Document that in the JSDoc.
- **`usePresence`:** like `useRoom`, but with a `PresenceHandle`. With `idleMs`:
  - if `typeof window !== "undefined" && typeof window.addEventListener === "function"`, listen to
    `pointermove`, `keydown` and `visibilitychange`, and call `handle.setIdle(true)` after `idleMs` with no
    input, `setIdle(false)` on input;
  - otherwise log one warning ("usePresence: idle detection needs a window; idle is never set") and skip.

- [ ] **Step 4: Run, sabotage, commit**

Run: `bun run test:react -- rooms`. Expected: PASS.

Each sabotage must fail a test:
- key the state by args only, without the client;
- subscribe `useEvent` through the presence store.

```bash
git add packages/react packages/sync-e2e/react/rooms.test.tsx
git commit -m "feat(react): useRoom with sub-hooks and usePresence with idle (AD-42)"
```

---

### Task 9: Measurement, docs, example

**Files:**
- Create: `bench/rooms.ts`, `examples/rooms-cursors/` (a minimal app: a `room` with cursors and a `wave` event, a
  `presence` facepile, and a React page)
- Create: `docs/rooms.md` (user docs: when to use a room or a scope, the API, the limits and knobs, and that a
  restart drops every room)
- Modify:
  - `docs/study/STUDY-164-ephemeral-rooms.md`: status "built (v1)", and a §7 "As built" listing the PRs and any
    ruling made on the way;
  - `docs/parity/additions.md`: AD-42 status → **built**;
  - `docs/parity/README.md`: the additions count;
  - `apps/site/src/content.ts`, if the site lists additions.

- [ ] **Step 1: Write the benchmark**

`bench/rooms.ts` starts a server (`createServer` with a memory engine) and N raw v1 clients (`v1Client`) in one
room. Each client sends presence at 20/s for 10 s. The benchmark records, per update, the time from send to
receipt at each other member, and reports p50 and p99 fan-out latency and the server's CPU
(`process.cpuUsage()` deltas).

Run it for N = 10, 100 and 500. Run the same N against "cursors in a table": one mutation per update into a
`cursors` table, with every client subscribed to a `list` query. Print a table.

- [ ] **Step 2: Run it**

Run: `bun bench/rooms.ts`.
Expected: rooms well below the table's latency and CPU at every N. Put the numbers in STUDY-164 §7 and in the PR.
If a room of 500 misses the tick budget (p99 above 100 ms), say so in the PR and open a follow-up. Do not
change the cap without the owner.

- [ ] **Step 3: Example and docs**

- Write the example with the generated `room` / `presence` and `useRoom` / `usePresence`.
- Add a browser test to the examples' Chromium job, the way the other examples' tests do it. Two pages: a cursor
  move in one appears in the other.
- Write `docs/rooms.md`.

- [ ] **Step 4: Run the whole check**

Run: `bun run check`. Expected: PASS. Run `bun run e2e` if the example joined the e2e job.

- [ ] **Step 5: Commit**

```bash
git add bench/rooms.ts examples/rooms-cursors docs apps/site
git commit -m "docs, bench: rooms and presence scopes as built; fan-out measured against cursors in a table (AD-42)"
```

---

## Self-review

- **Spec coverage:**

  | STUDY-164 section | Where |
  |---|---|
  | §3.1 kinds | presence, events (Tasks 3, 5); no room state (constraint) |
  | §3.2 | not readable from queries (Task 6 test) |
  | §3.3 API | Task 2 definitions; Tasks 7–8 hooks; scope per user, merged on the server (Task 3) |
  | §3.4 gates | Task 5 |
  | §3.4 broadcast | Tasks 4, 6 |
  | §3.4 member reads | Task 6, actions only |
  | §3.5 grace | Tasks 3, 5, 7 |
  | §3.5 throttle and coalescing | Tasks 7, 3 |
  | §3.5 limits | Tasks 3, 5 |
  | §3.5 backpressure | Task 3 |
  | §3.6 wire | Task 1 |
  | §3.7 | single process, no Redis (nothing to build) |
  | §5 tests | each task; measurement in Task 9 |
  | §6 | R1–R9 all reflected |
- **Placeholders:** Tasks 5–8 list some test cases as one-line specs, not full code. Each names its exact
  assertion and harness (`v1Client`, `startServer`, `react.test.tsx` setup). Write each as its own `test(...)`.
  The core logic tests (Tasks 1, 3, 4) are given in full.
- **Type consistency:** `RoomKey`, `RoomSink`, `RoomHub` methods, `v1.RoomMember`, `Functions.roomDef` and
  `Tx.afterCommit` are used with the same names and shapes in Tasks 3–8.
- **Review Focus:**

  | Line | Pinned in |
  |---|---|
  | 1 | Task 5 (gate throws) |
  | 2 | Task 5 (gate race) |
  | 3 | Task 7 (ref-count) |
  | 4 | Tasks 4 and 6 (OCC, nested) |
  | 5 | Task 3 (three tabs) |

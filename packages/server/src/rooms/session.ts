// One connection's rooms (AD-42, STUDY-164 §3.4–3.6): the protocol messages to and from the hub, the gates run
// as queries with the connection's identity, and the validation of presence, events and their sizes.
import type { Caller } from "@bunvex/core";
import type { v1 } from "@bunvex/protocol";
import { checkValue, type Value } from "@bunvex/values";
import { type Functions, registryKey } from "../functions.ts";
import type { AnyRoomDef, RoomGate } from "./define.ts";
import { type RoomHub, type RoomKey, type RoomSink, roomKeyString } from "./hub.ts";
import type { RoomLimits } from "./limits.ts";

type JSONValue = v1.JSONValue;
export type RoomMessage = v1.RoomJoin | v1.RoomLeave | v1.RoomPresence | v1.RoomClientEvent;
type Deps = { hub: RoomHub; functions: Functions; limits: RoomLimits; fromWire: (a: JSONValue) => Value };
type Io = {
  sessionId(): string;
  send(frame: v1.ServerMessage): void;
  /** Bytes queued to the socket. */
  buffered(): number;
  /** Close the connection (the client reconnects); called again once closed, it does nothing. */
  close(reason: string): void;
  caller(): Caller;
};

/** A refused or failing gate, whatever the reason: what the gate said or threw stays on the server. */
const NO_ACCESS = "You cannot join this room.";
const SIGNED_IN = "A presence scope is for signed-in users.";
const NOT_JOINED = "Not in this room.";
const FULL = "This room is full, or this connection is in too many rooms.";

/**
 * JSON with every object's keys sorted, at every level: one room key for the same args in any key order. The
 * sorted copies have no prototype, so a `__proto__` key stays a key.
 */
export function canonicalJson(x: JSONValue): string {
  return JSON.stringify(sorted(x));
}
function sorted(x: JSONValue): JSONValue {
  if (Array.isArray(x)) return x.map(sorted);
  if (x === null || typeof x !== "object") return x;
  const out: Record<string, JSONValue> = Object.create(null);
  for (const k of Object.keys(x).sort()) out[k] = sorted(x[k] as JSONValue);
  return out;
}

const bytes = (x: JSONValue) => Buffer.byteLength(JSON.stringify(x));

type Joined = { def: AnyRoomDef; key: RoomKey; args: Value; userId: string | null };

export class RoomConnection implements RoomSink {
  private readonly joined = new Map<number, Joined>();
  private closedFlag = false;
  /** When `rate_limited` was last reported (at most once a second). */
  private warnedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly deps: Deps,
    private readonly io: Io,
  ) {}

  get sessionId() {
    return this.io.sessionId();
  }
  send(frame: v1.ServerMessage) {
    this.io.send(frame);
  }
  behind() {
    return this.io.buffered();
  }
  resync() {
    this.io.close("room frames too far behind");
  }
  /** The dashboard removed the membership (the hub let it go): the client is told, and the room forgotten. */
  evict(roomId: number, code: "removed", message: string) {
    this.joined.delete(roomId);
    this.left(roomId, code, message);
  }

  async handle(m: RoomMessage): Promise<void> {
    switch (m.type) {
      case "RoomJoin":
        return this.join(m);
      case "RoomLeave":
        // Idempotent: a client may leave a room whose join was refused.
        this.joined.delete(m.roomId);
        this.deps.hub.leave(this, m.roomId);
        return;
      case "RoomPresence":
        return this.presence(m);
      case "RoomEvent":
        return this.event(m);
    }
  }

  private error(roomId: number, code: v1.RoomErrorCode, message: string) {
    this.send({ type: "RoomError", roomId, code, message });
  }

  /** A value from the wire, or the reason it is not one. */
  private parse(x: JSONValue): { value: Value } | { error: string } {
    try {
      return { value: this.deps.fromWire(x) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  private async join(m: v1.RoomJoin) {
    // A join that reuses a roomId replaces what it named.
    if (this.joined.delete(m.roomId)) this.deps.hub.leave(this, m.roomId);
    const def = this.deps.functions.roomDef(m.name);
    if (!def || def.kind !== m.kind) return this.error(m.roomId, "not_found", `No ${m.kind} named "${m.name}".`);
    if (bytes(m.args) > this.deps.limits.argsBytes)
      return this.error(m.roomId, "limit", "The room's arguments are too large.");
    const parsed = this.parse(m.args);
    if ("error" in parsed) return this.error(m.roomId, "validation", parsed.error);
    const args = parsed.value;
    if (def.args) {
      const why = checkValue(def.args, args);
      if (why) return this.error(m.roomId, "validation", why);
    }
    const caller = this.io.caller();
    const userId = subjectOf(caller);
    // Checked before the hub, which keys a scope's member by its user.
    if (def.kind === "presence" && userId === null) {
      this.deps.hub.countGateRefusal();
      return this.error(m.roomId, "no_access", SIGNED_IN);
    }
    // The gates are named by the room's registry name, as on an identity change: one name in the logs.
    const room = { key: { name: registryKey(m.name) }, args };
    const allowed = await this.gate(def.canJoin, "canJoin", room, caller);
    const canPublish =
      allowed && (def.kind === "presence" || (await this.gate(def.canPublish, "canPublish", room, caller)));
    // The socket may have closed while the gates ran: a member inserted now would never be removed.
    if (this.closedFlag) return;
    if (!allowed) {
      this.deps.hub.countGateRefusal();
      return this.error(m.roomId, "no_access", NO_ACCESS);
    }
    // One room whatever the spelling of its name (`rooms:doc`, `rooms.js:doc`) or the order of its args' keys.
    const key: RoomKey = { kind: def.kind, name: room.key.name, argsJson: canonicalJson(m.args) };
    if (!this.attach(m.roomId, { def, key, args, userId }, canPublish)) this.error(m.roomId, "limit", FULL);
  }

  /** Join the hub (false: over a cap); the hub ends any other attachment of this connection to the same room. */
  private attach(roomId: number, j: Joined, canPublish: boolean): boolean {
    const ks = roomKeyString(j.key);
    for (const [id, other] of this.joined) if (roomKeyString(other.key) === ks) this.joined.delete(id);
    if (this.deps.hub.join(this, roomId, j.key, { userId: j.userId, canPublish }) === "limit") return false;
    this.joined.set(roomId, j);
    return true;
  }

  /** A joined membership the server ended on its own: the client's handle ends too (it is not a join error). */
  private left(roomId: number, code: v1.RoomLeftCode, message: string) {
    this.deps.hub.countRoomLeft();
    this.send({ type: "RoomLeft", roomId, code, message });
  }

  /**
   * A gate: absent is "yes"; it runs as a query with the caller's identity, named `<room>#<gate>`; a throw is
   * "no", with no internals.
   */
  private async gate(
    g: RoomGate | undefined,
    which: "canJoin" | "canPublish",
    room: { key: { name: string }; args: Value },
    caller: Caller,
  ): Promise<boolean> {
    if (!g) return true;
    try {
      return (await this.deps.functions.runGate(g, `${room.key.name}#${which}`, room.args, caller)) === true;
    } catch {
      return false;
    }
  }

  private presence(m: v1.RoomPresence) {
    const j = this.joined.get(m.roomId);
    if (!j) return this.error(m.roomId, "not_found", NOT_JOINED);
    if (bytes(m.presence) > this.deps.limits.payloadBytes)
      return this.error(m.roomId, "limit", "The presence is too large.");
    const parsed = this.parse(m.presence);
    if ("error" in parsed) return this.error(m.roomId, "validation", parsed.error);
    const why = checkValue(j.def.kind === "room" ? j.def.presence : j.def.state, parsed.value);
    if (why) return this.error(m.roomId, "validation", why);
    this.report(m.roomId, this.deps.hub.setPresence(this, m.roomId, m.presence, m.idle));
  }

  private event(m: v1.RoomClientEvent) {
    const j = this.joined.get(m.roomId);
    if (!j || j.def.kind !== "room") return this.error(m.roomId, "not_found", NOT_JOINED);
    const validator = Object.hasOwn(j.def.events, m.event) ? j.def.events[m.event] : undefined;
    if (!validator) return this.error(m.roomId, "validation", `This room has no event "${m.event}".`);
    if (bytes(m.data) > this.deps.limits.payloadBytes) return this.error(m.roomId, "limit", "The event is too large.");
    const parsed = this.parse(m.data);
    if ("error" in parsed) return this.error(m.roomId, "validation", parsed.error);
    const why = checkValue(validator, parsed.value);
    if (why) return this.error(m.roomId, "validation", why);
    this.report(m.roomId, this.deps.hub.event(this, m.roomId, m.event, m.data));
  }

  /** `forbidden` is reported each time; `rate_limited` at most once a second (the excess is dropped). */
  private report(roomId: number, r: "ok" | "forbidden" | "rate_limited") {
    if (r === "forbidden") this.error(roomId, "forbidden", "This connection may not publish in this room.");
    if (r === "rate_limited" && performance.now() - this.warnedAt >= 1000) {
      this.warnedAt = performance.now();
      this.error(roomId, "rate_limited", "Too many updates: some were dropped.");
    }
  }

  /** The identity changed: every room's gates run again; a room now refused is left, another user rejoins. */
  async identityChanged() {
    const caller = this.io.caller();
    const userId = subjectOf(caller);
    const rooms = [...this.joined];
    // Every room's gates at once (still inside the inbox, so the next message waits for all of them).
    const verdicts = await Promise.all(
      rooms.map(async ([, j]) => {
        const ok =
          (j.def.kind !== "presence" || userId !== null) && (await this.gate(j.def.canJoin, "canJoin", j, caller));
        const canPublish =
          ok && (j.def.kind === "presence" || (await this.gate(j.def.canPublish, "canPublish", j, caller)));
        return { ok, canPublish };
      }),
    );
    if (this.closedFlag) return;
    // Applied in the rooms' order.
    rooms.forEach(([roomId, j], i) => {
      const { ok, canPublish } = verdicts[i]!;
      if (ok && userId === j.userId) {
        if (j.def.kind === "room") this.deps.hub.setCanPublish(this, roomId, canPublish);
        return;
      }
      // Refused, or a different user, who is a different member: the old one leaves, the new one joins.
      this.joined.delete(roomId);
      this.deps.hub.leave(this, roomId);
      if (!ok) this.left(roomId, "no_access", NO_ACCESS);
      else if (!this.attach(roomId, { ...j, userId }, canPublish)) this.left(roomId, "limit", FULL);
    });
  }

  /** The connection closed: its memberships are kept for the reconnect grace. */
  closed() {
    this.closedFlag = true;
    this.deps.hub.detach(this);
  }
}

/** The member's user: the identity's subject, or null when anonymous. */
function subjectOf(caller: Caller): string | null {
  const id = caller.identity as { subject?: unknown } | null | undefined;
  return typeof id?.subject === "string" ? id.subject : null;
}

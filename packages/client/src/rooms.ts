// Rooms and presence scopes on the client (AD-42, STUDY-164 §3.5, §3.6): memberships ref-counted by
// (kind, name, canonical args), rejoined on every new socket (the server's room ids are per connection), a
// full snapshot at every RoomSync, and presence sent at most every 50 ms on the leading and trailing edge.
import type { v1 } from "@bunvex/protocol";
import { fromJsonValue, toJsonValue, type Value } from "@bunvex/values";
import type { Logger } from "./logging.ts";

export type RoomMemberView<P> = { memberId: string; userId: string | null; presence: P | null };
export type RoomStatus = "joining" | "joined" | "error";
export type RoomHandleError = { code: string; message: string };

export interface RoomHandle<P, E extends Record<string, unknown>> {
  readonly status: RoomStatus;
  readonly error: RoomHandleError | null;
  /** This connection's member id, once joined. */
  readonly self: string | null;
  readonly canPublish: boolean;
  /** The other members: a stable array, replaced on change. */
  others(): RoomMemberView<P>[];
  myPresence(): P | null;
  /** Throttled to one send per 50 ms, on the leading and trailing edge. */
  setPresence(p: P): void;
  broadcast<K extends keyof E & string>(event: K, data: E[K]): void;
  on<K extends keyof E & string>(event: K, cb: (from: string | null, data: E[K]) => void): () => void;
  /** Called on any change of status, others or canPublish. */
  subscribe(cb: () => void): () => void;
  leave(): void;
}

export interface PresenceHandle<S> {
  readonly status: RoomStatus;
  readonly error: RoomHandleError | null;
  /** The other signed-in users in the scope (you left out): a stable array, replaced on change. */
  others(): { userId: string; state: S | null; idle: boolean }[];
  /** The users in the scope, you included. */
  count(): number;
  /** Throttled like a room's presence. */
  setState(s: S): void;
  /** Sent with the state: before the first `setState` it is kept until there is one. */
  setIdle(idle: boolean): void;
  subscribe(cb: () => void): () => void;
  leave(): void;
}

type Member = { memberId: string; userId: string | null; presence: Value | null; idle: boolean };

type Membership = {
  kind: v1.RoomKind;
  name: string;
  key: string;
  wireArgs: v1.JSONValue;
  roomId: number;
  /** Whether RoomJoin went out on the current socket. */
  sent: boolean;
  refs: number;
  status: RoomStatus;
  error: RoomHandleError | null;
  self: string | null;
  canPublish: boolean;
  members: Map<string, Member>;
  /** The local state: what `setPresence` / `setState` last said. */
  presence: Value | undefined;
  idle: boolean | undefined;
  /** Whether the state changed since the last RoomPresence. */
  dirty: boolean;
  lastSentAt: number;
  timer: unknown;
  listeners: Set<() => void>;
  eventListeners: Map<string, Set<(from: string | null, data: Value) => void>>;
  othersCache: Member[];
};

export type RoomManagerClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** One presence send per this many milliseconds. */
export const PRESENCE_THROTTLE_MS = 50;

const SYSTEM_CLOCK: RoomManagerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** JSON with every object's keys sorted, so equal args are one key. */
function canonical(x: v1.JSONValue): string {
  const sorted = (y: v1.JSONValue): v1.JSONValue => {
    if (Array.isArray(y)) return y.map(sorted);
    if (typeof y === "object" && y !== null) {
      const out: { [k: string]: v1.JSONValue } = {};
      for (const k of Object.keys(y).sort()) out[k] = sorted((y as { [k: string]: v1.JSONValue })[k]!);
      return out;
    }
    return y;
  };
  return JSON.stringify(sorted(x));
}

const toMember = (m: v1.RoomMember): Member => ({
  memberId: m.memberId,
  userId: m.userId,
  presence: m.presence === null ? null : fromJsonValue(m.presence),
  idle: m.idle === true,
});

export class RoomManager {
  private nextRoomId = 0;
  private readonly byKey = new Map<string, Membership>();
  private readonly byId = new Map<number, Membership>();
  /** RoomLeave frames that found the socket paused; sent on resume (a new socket forgets them). */
  private pendingLeaves: number[] = [];

  constructor(
    private readonly send: (m: v1.ClientMessage) => boolean,
    private readonly logger: Logger,
    private readonly clock: RoomManagerClock = SYSTEM_CLOCK,
  ) {}

  joinRoom<P, E extends Record<string, unknown>>(name: string, args: unknown): RoomHandle<P, E> {
    return this.roomHandle<P, E>(this.join("room", name, args));
  }

  joinPresence<S>(name: string, args: unknown): PresenceHandle<S> {
    return this.presenceHandle<S>(this.join("presence", name, args));
  }

  /** A new socket: every membership gets a fresh room id, and joins again with its last presence. */
  onOpen() {
    this.byId.clear();
    this.pendingLeaves = [];
    for (const m of this.byKey.values()) {
      if (m.timer !== undefined) this.clock.clearTimeout(m.timer);
      m.timer = undefined;
      m.roomId = this.nextRoomId++;
      this.byId.set(m.roomId, m);
      m.sent = false;
      m.status = "joining";
      m.error = null;
      m.dirty = m.presence !== undefined;
      m.lastSentAt = Number.NEGATIVE_INFINITY;
      this.notify(m);
    }
    this.flush();
  }

  /** The socket was paused and is sending again. */
  onResume() {
    this.flush();
  }

  onMessage(msg: v1.ServerMessage) {
    switch (msg.type) {
      case "RoomSync": {
        const m = this.byId.get(msg.roomId);
        if (!m) return;
        // Every sync is a fresh full snapshot: members, self and canPublish are replaced.
        m.self = msg.self;
        m.canPublish = msg.canPublish;
        m.status = "joined";
        m.error = null;
        m.members = new Map(msg.members.filter((x) => x.memberId !== msg.self).map((x) => [x.memberId, toMember(x)]));
        this.rebuildOthers(m);
        this.notify(m);
        return;
      }
      case "RoomMembers": {
        const m = this.byId.get(msg.roomId);
        if (!m) return;
        const members = new Map(m.members);
        for (const x of msg.set) if (x.memberId !== m.self) members.set(x.memberId, toMember(x));
        for (const id of msg.left) members.delete(id);
        m.members = members;
        this.rebuildOthers(m);
        this.notify(m);
        return;
      }
      case "RoomEvent": {
        const m = this.byId.get(msg.roomId);
        const cbs = m?.eventListeners.get(msg.event);
        if (!cbs) return;
        const data = fromJsonValue(msg.data);
        for (const cb of [...cbs]) cb(msg.from, data);
        return;
      }
      case "RoomError": {
        const m = this.byId.get(msg.roomId);
        if (!m) return;
        if (msg.code === "rate_limited" || msg.code === "forbidden") {
          this.logger.warn(`Room ${m.name}: ${msg.code}: ${msg.message}`);
          return;
        }
        if (m.status !== "joining") {
          // A payload error on a live membership, or a second one after a join error: not a new status.
          this.logger.warn(`Room ${m.name}: ${msg.code}: ${msg.message}`);
          return;
        }
        m.status = "error";
        m.error = { code: msg.code, message: msg.message };
        this.notify(m);
        return;
      }
    }
  }

  private join(kind: v1.RoomKind, name: string, args: unknown): Membership {
    const wireArgs = toJsonValue((args ?? {}) as Value);
    const key = `${kind}|${name}|${canonical(wireArgs)}`;
    let m = this.byKey.get(key);
    if (!m) {
      m = {
        kind,
        name,
        key,
        wireArgs,
        roomId: this.nextRoomId++,
        sent: false,
        refs: 0,
        status: "joining",
        error: null,
        self: null,
        canPublish: false,
        members: new Map(),
        presence: undefined,
        idle: undefined,
        dirty: false,
        lastSentAt: Number.NEGATIVE_INFINITY,
        timer: undefined,
        listeners: new Set(),
        eventListeners: new Map(),
        othersCache: [],
      };
      this.byKey.set(key, m);
      this.byId.set(m.roomId, m);
    }
    m.refs++;
    this.flush();
    return m;
  }

  /** Send RoomJoin (and the held presence) for each membership not yet joined on this socket. */
  private flush() {
    while (this.pendingLeaves.length > 0) {
      if (!this.send({ type: "RoomLeave", roomId: this.pendingLeaves[0]! })) return;
      this.pendingLeaves.shift();
    }
    for (const m of this.byKey.values()) {
      if (m.sent) {
        if (m.dirty && m.timer === undefined) this.sendPresence(m); // held while the socket was paused
        continue;
      }
      if (!this.send({ type: "RoomJoin", roomId: m.roomId, kind: m.kind, name: m.name, args: m.wireArgs })) return;
      m.sent = true;
      if (m.dirty) this.sendPresence(m);
    }
  }

  private release(m: Membership) {
    if (--m.refs > 0) return;
    if (m.timer !== undefined) this.clock.clearTimeout(m.timer);
    m.timer = undefined;
    this.byKey.delete(m.key);
    this.byId.delete(m.roomId);
    if (m.sent && !this.send({ type: "RoomLeave", roomId: m.roomId })) this.pendingLeaves.push(m.roomId);
  }

  private rebuildOthers(m: Membership) {
    m.othersCache = [...m.members.values()];
  }

  private notify(m: Membership) {
    for (const cb of [...m.listeners]) cb();
  }

  private sendPresence(m: Membership) {
    if (m.presence === undefined) return; // an idle flag waits for a state: the server validates every send
    const sent = this.send({
      type: "RoomPresence",
      roomId: m.roomId,
      presence: toJsonValue(m.presence),
      ...(m.idle === undefined ? {} : { idle: m.idle }),
    });
    if (!sent) return; // paused: stays dirty, goes out on resume
    m.dirty = false;
    m.lastSentAt = this.clock.now();
  }

  /** Leading edge at once; otherwise one trailing send at the end of the window, with the latest value. */
  private publish(m: Membership) {
    m.dirty = true;
    if (!m.sent || m.timer !== undefined) return; // held for the join, or the trailing send is scheduled
    const wait = m.lastSentAt + PRESENCE_THROTTLE_MS - this.clock.now();
    if (wait <= 0) {
      this.sendPresence(m);
      return;
    }
    m.timer = this.clock.setTimeout(() => {
      m.timer = undefined;
      if (m.dirty && m.sent) this.sendPresence(m);
    }, wait);
  }

  private subscribeTo(m: Membership, own: Set<() => void>, cb: () => void): () => void {
    m.listeners.add(cb);
    const off = () => {
      m.listeners.delete(cb);
      own.delete(off);
    };
    own.add(off);
    return off;
  }

  private roomHandle<P, E extends Record<string, unknown>>(m: Membership): RoomHandle<P, E> {
    const own = new Set<() => void>();
    let left = false;
    return {
      get status() {
        return m.status;
      },
      get error() {
        return m.error;
      },
      get self() {
        return m.self;
      },
      get canPublish() {
        return m.canPublish;
      },
      others: () => m.othersCache as RoomMemberView<P>[],
      myPresence: () => (m.presence === undefined ? null : (m.presence as P)),
      setPresence: (p) => {
        if (left) return;
        m.presence = p as Value;
        this.publish(m);
      },
      broadcast: (event, data) => {
        if (left || !m.sent) return;
        this.send({ type: "RoomEvent", roomId: m.roomId, event, data: toJsonValue(data as Value) });
      },
      on: (event, cb) => {
        let set = m.eventListeners.get(event);
        if (!set) {
          set = new Set();
          m.eventListeners.set(event, set);
        }
        const mine = set;
        const fn = cb as (from: string | null, data: Value) => void;
        set.add(fn);
        const off = () => {
          mine.delete(fn);
          own.delete(off);
        };
        own.add(off);
        return off;
      },
      subscribe: (cb) => this.subscribeTo(m, own, cb),
      leave: () => {
        if (left) return;
        left = true;
        for (const off of [...own]) off();
        this.release(m);
      },
    };
  }

  private presenceHandle<S>(m: Membership): PresenceHandle<S> {
    const own = new Set<() => void>();
    let left = false;
    let cache: { source: Member[]; view: { userId: string; state: S | null; idle: boolean }[] } | undefined;
    return {
      get status() {
        return m.status;
      },
      get error() {
        return m.error;
      },
      others: () => {
        if (cache?.source !== m.othersCache)
          cache = {
            source: m.othersCache,
            view: m.othersCache.map((x) => ({
              userId: x.userId ?? x.memberId,
              state: x.presence as S | null,
              idle: x.idle,
            })),
          };
        return cache.view;
      },
      count: () => m.members.size + 1,
      setState: (s) => {
        if (left) return;
        m.presence = s as Value;
        this.publish(m);
      },
      setIdle: (idle) => {
        if (left) return;
        m.idle = idle;
        this.publish(m);
      },
      subscribe: (cb) => this.subscribeTo(m, own, cb),
      leave: () => {
        if (left) return;
        left = true;
        for (const off of [...own]) off();
        this.release(m);
      },
    };
  }
}

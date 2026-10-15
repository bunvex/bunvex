// `useRoom` and `usePresence` (AD-42, STUDY-164 §3.5): a membership joined in an effect and left in its
// cleanup (StrictMode's mount, unmount, mount leaves one member: the client ref-counts joins). The joined
// handle is stored with the client and the key of the args it was joined for, and is only used while both
// still match the render, so a switch of args or provider never shows the previous room's members.
import {
  getFunctionName,
  type PresenceHandle,
  type RoomHandle,
  type RoomHandleError,
  type RoomMemberView,
  type RoomReference,
  type RoomStatus,
} from "@bunvex/client";
import { toJsonValue, type Value } from "@bunvex/values";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BunvexReactClient } from "./client.ts";
import { useRequiredClient } from "./context.ts";

type Handle = {
  readonly status: RoomStatus;
  readonly error: RoomHandleError | null;
  subscribe(cb: () => void): () => void;
  leave(): void;
};

const noopSubscribe = () => () => {};

/** The handle joined for this client and key, or null while there is none (skipped, or not joined yet). */
function useJoined<H extends Handle>(
  client: BunvexReactClient,
  key: string | null,
  join: () => H,
): { handle: H | null; status: RoomStatus; error: RoomHandleError | null } {
  const [joined, setJoined] = useState<{ client: BunvexReactClient; key: string; handle: H } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `join` is a closure over the key
  useEffect(() => {
    if (key === null) {
      setJoined(null);
      return;
    }
    const handle = join();
    setJoined({ client, key, handle });
    return () => handle.leave();
  }, [client, key]);
  const handle = joined !== null && joined.client === client && joined.key === key ? joined.handle : null;
  // Status and error are their own subscriptions: a change of members re-renders only who reads them.
  const subscribe = useMemo(() => (handle ? (cb: () => void) => handle.subscribe(cb) : noopSubscribe), [handle]);
  const status = useSyncExternalStore(
    subscribe,
    () => (handle?.status ?? "joining") as RoomStatus,
    () => "joining" as RoomStatus,
  );
  const error = useSyncExternalStore(
    subscribe,
    () => handle?.error ?? null,
    () => null,
  );
  return { handle, status, error };
}

function argsKey(ref: unknown, args: unknown): string {
  return `${getFunctionName(ref as never)}|${JSON.stringify(toJsonValue((args ?? {}) as Value))}`;
}

const NO_MEMBERS: never[] = [];

/** The sub-hooks of a joined room (or of none yet): hooks, called through the object `useRoom` returns. */
function roomHooks<R extends RoomReference<"room", any, any, any>>(
  handle: RoomHandle<R["_presence"], R["_events"]> | null,
  sub: (cb: () => void) => () => void,
) {
  type P = R["_presence"];
  const own = new Set<() => void>();
  return {
    useOthers(): RoomMemberView<P>[] {
      return useSyncExternalStore(
        sub,
        () => (handle ? handle.others() : NO_MEMBERS) as RoomMemberView<P>[],
        () => NO_MEMBERS as RoomMemberView<P>[],
      );
    },
    useMyPresence(): [P | null, (p: P) => void] {
      // The handle does not announce a change of its own presence: this hook's setter does.
      const mine = useSyncExternalStore(
        (cb) => {
          const off = sub(cb);
          own.add(cb);
          return () => {
            own.delete(cb);
            off();
          };
        },
        () => (handle ? handle.myPresence() : null) as P | null,
        () => null,
      );
      const set = useCallback(
        (p: P) => {
          handle?.setPresence(p);
          for (const cb of [...own]) cb();
        },
        [handle, own],
      );
      return [mine, set];
    },
    useBroadcast<K extends keyof R["_events"] & string>(event: K): (data: R["_events"][K]) => void {
      return useCallback((data: R["_events"][K]) => handle?.broadcast(event, data), [handle, event]);
    },
    useEvent<K extends keyof R["_events"] & string>(
      event: K,
      cb: (from: string | null, data: R["_events"][K]) => void,
    ): void {
      const latest = useRef(cb);
      latest.current = cb;
      useEffect(() => {
        if (!handle) return;
        return handle.on(event, (from, data) => latest.current(from, data));
      }, [handle, event]);
    },
  };
}

/**
 * Join a room (`args` "skip" joins nothing). `useOthers`, `useMyPresence`, `useBroadcast` and `useEvent` are
 * hooks: call them at the top level of a component, the same ones in the same order on every render. A
 * component that calls only some of them re-renders only for what they read.
 */
export function useRoom<R extends RoomReference<"room", any, any, any>>(
  ref: R,
  args: R["_args"] | "skip",
): {
  status: RoomStatus;
  error: RoomHandleError | null;
  useOthers(): RoomMemberView<R["_presence"]>[];
  useMyPresence(): [R["_presence"] | null, (p: R["_presence"]) => void];
  useBroadcast<K extends keyof R["_events"] & string>(event: K): (data: R["_events"][K]) => void;
  useEvent<K extends keyof R["_events"] & string>(
    event: K,
    cb: (from: string | null, data: R["_events"][K]) => void,
  ): void;
} {
  const client = useRequiredClient("useRoom");
  const key = args === "skip" ? null : argsKey(ref, args);
  const { handle, status, error } = useJoined(client, key, () =>
    client.sync.joinRoom(ref as RoomReference<"room", unknown, R["_presence"], R["_events"]>, args as unknown),
  );
  const sub = useMemo(() => (handle ? (cb: () => void) => handle.subscribe(cb) : noopSubscribe), [handle]);
  const api = useMemo(() => roomHooks<R>(handle, sub), [handle, sub]);
  return { status, error, ...api };
}

/**
 * Join a presence scope (`args` "skip" joins nothing): who among the signed-in users is here. With `idleMs`,
 * a user with no pointer or key input for that long is idle to the others (needs a `window`).
 */
export function usePresence<R extends RoomReference<"presence", any, any>>(
  ref: R,
  args: R["_args"] | "skip",
  opts?: { idleMs?: number },
): {
  status: RoomStatus;
  error: RoomHandleError | null;
  others: { userId: string; state: R["_presence"] | null; idle: boolean }[];
  count: number;
  me: R["_presence"] | null;
  setMyState(s: R["_presence"]): void;
  isIdle: boolean;
} {
  type S = R["_presence"];
  const client = useRequiredClient("usePresence");
  const key = args === "skip" ? null : argsKey(ref, args);
  const { handle, status, error } = useJoined<PresenceHandle<S>>(client, key, () =>
    client.sync.joinPresence(ref as RoomReference<"presence", unknown, S>, args as unknown),
  );
  const sub = useMemo(() => (handle ? (cb: () => void) => handle.subscribe(cb) : noopSubscribe), [handle]);
  const others = useSyncExternalStore(
    sub,
    () => (handle ? handle.others() : NO_MEMBERS) as { userId: string; state: S | null; idle: boolean }[],
    () => NO_MEMBERS as { userId: string; state: S | null; idle: boolean }[],
  );
  const count = useSyncExternalStore(
    sub,
    () => (handle ? handle.count() : 0),
    () => 0,
  );
  const [mine, setMine] = useState<{ handle: PresenceHandle<S>; state: S } | null>(null);
  const setMyState = useCallback(
    (s: S) => {
      if (!handle) return;
      handle.setState(s);
      setMine({ handle, state: s });
    },
    [handle],
  );
  const me = mine !== null && mine.handle === handle ? mine.state : null;
  const isIdle = useIdle(handle, opts?.idleMs);
  return { status, error, others, count, me, setMyState, isIdle };
}

let warnedNoWindow = false;

/** The part of a browser window the idle detection uses (this package builds without the DOM lib). */
type IdleWindow = {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  document?: { visibilityState?: string };
};

/** Whether the user has had no input for `idleMs`, sent to the handle as it changes. */
function useIdle(handle: PresenceHandle<never> | PresenceHandle<any> | null, idleMs: number | undefined): boolean {
  const [idleFor, setIdleFor] = useState<unknown>(null);
  useEffect(() => {
    if (!handle || idleMs === undefined) return;
    const win = (globalThis as { window?: IdleWindow }).window;
    if (typeof win === "undefined" || typeof win.addEventListener !== "function") {
      if (!warnedNoWindow) {
        warnedNoWindow = true;
        console.warn("usePresence: idle detection needs a window; idle is never set");
      }
      return;
    }
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const set = (v: boolean) => {
      idle = v;
      handle.setIdle(v);
      setIdleFor(v ? handle : null);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => set(true), idleMs);
    };
    const onInput = () => {
      if (idle) set(false);
      arm();
    };
    const onVisibility = () => {
      if (win.document?.visibilityState !== "hidden") onInput();
    };
    win.addEventListener("pointermove", onInput);
    win.addEventListener("keydown", onInput);
    win.addEventListener("visibilitychange", onVisibility);
    arm();
    return () => {
      clearTimeout(timer);
      win.removeEventListener("pointermove", onInput);
      win.removeEventListener("keydown", onInput);
      win.removeEventListener("visibilitychange", onVisibility);
      setIdleFor(null);
    };
  }, [handle, idleMs]);
  return handle !== null && idleFor === handle;
}

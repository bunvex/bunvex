// Rooms and presence scopes (AD-42, STUDY-164 §3.3): definitions an app exports from its functions directory, as
// it exports functions. They are not functions: no client calls them, and no query reads them.
import { type GenericValidator, v } from "@bunvex/values";
import type { GenericQueryCtx, PresenceBuilder, RoomBuilder } from "../registration.ts";

/** A gate, run with a query's ctx at join and on an identity change (never reactively). */
// biome-ignore lint/suspicious/noExplicitAny: a gate is typed by its builder, per data model and args
export type RoomGate = (ctx: GenericQueryCtx<any>, args: any) => boolean | Promise<boolean>;
export type RoomDef = {
  kind: "room";
  args: GenericValidator | undefined;
  /** Absent: everyone may join. */
  canJoin: RoomGate | undefined;
  /** Absent: every member may publish. */
  canPublish: RoomGate | undefined;
  presence: GenericValidator;
  events: Record<string, GenericValidator>;
};
export type PresenceDef = {
  kind: "presence";
  args: GenericValidator | undefined;
  /** Signed-in users only, whatever it says. */
  canJoin: RoomGate | undefined;
  state: GenericValidator;
};
export type AnyRoomDef = RoomDef | PresenceDef;

const DEFINED = new WeakSet<object>();
/** Whether `x` is what `room()` or `presence()` returned. */
export const isRoomDef = (x: unknown): x is AnyRoomDef => typeof x === "object" && x !== null && DEFINED.has(x);

type Fields = GenericValidator | Record<string, GenericValidator>;
const validatorOf = (x: Fields): GenericValidator =>
  (x as GenericValidator).isValidator === true
    ? (x as GenericValidator)
    : v.object(x as Record<string, GenericValidator>);

function defineRoom(spec: {
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

function definePresence(spec: { args?: Fields; canJoin?: RoomGate; state: Fields }) {
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

// biome-ignore lint/suspicious/noExplicitAny: no data model
type AnyDM = any;
/** `room` without a data model; `_generated/server` re-exports it typed with the app's. */
export const roomGeneric = defineRoom as unknown as RoomBuilder<AnyDM>;
/** `presence` without a data model; `_generated/server` re-exports it typed with the app's. */
export const presenceGeneric = definePresence as unknown as PresenceBuilder<AnyDM>;
export const room = roomGeneric;
export const presence = presenceGeneric;

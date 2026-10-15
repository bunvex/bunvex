// The server side of rooms (AD-42, STUDY-164 §3.4): broadcast from mutations (after the commit) and from actions;
// members read from actions only, so that queries and mutations stay functions of the database.

import { parseValue } from "@bunvex/core";
import { type AnyFunctionReference, getFunctionName } from "@bunvex/protocol";
import { checkValue, toJsonValue, type Value } from "@bunvex/values";
import { ValidatorError } from "../errors.ts";
import { type Functions, registryKey } from "../functions.ts";
import type { RoomKey } from "./hub.ts";
import { canonicalJson } from "./session.ts";

type Ref = AnyFunctionReference | string;

/**
 * `onCommit` runs a broadcast once the mutation committed (absent: an action, which sends at once); `canRead`
 * adds `rooms.members` and `presence.list`, which only actions get.
 */
export function roomsCtx(functions: Functions, onCommit: ((fn: () => void) => void) | null, canRead: boolean) {
  const resolve = (ref: Ref, kind: "room" | "presence", args: unknown) => {
    const name = getFunctionName(ref);
    const def = functions.roomDef(name);
    if (!def || def.kind !== kind) throw new Error(`No ${kind} named "${name}".`);
    const value = (args ?? {}) as Value;
    if (def.args) {
      const why = checkValue(def.args, value);
      if (why) throw ValidatorError.args(why);
    }
    // The key a client's join of the same room makes (session.ts): same name form, same canonical wire args.
    const key: RoomKey = { kind, name: registryKey(name), argsJson: canonicalJson(toJsonValue(value)) };
    return { def, key };
  };
  const rooms = {
    async broadcast(ref: Ref, args: unknown, event: string, data: unknown) {
      const { def, key } = resolve(ref, "room", args);
      const validator = def.kind === "room" && Object.hasOwn(def.events, event) ? def.events[event] : undefined;
      if (!validator) throw new Error(`This room has no event "${event}".`);
      const value = data as Value;
      const why = checkValue(validator, value);
      if (why) throw ValidatorError.args(why);
      const wire = toJsonValue(value);
      // The client events' limit, measured the same way (session.ts).
      const limit = functions.roomHub?.limits.payloadBytes;
      if (limit !== undefined && Buffer.byteLength(JSON.stringify(wire)) > limit)
        throw new Error("The event is too large.");
      const send = () => functions.roomHub?.broadcast(key, event, wire);
      if (onCommit) onCommit(send);
      else send();
    },
    ...(canRead
      ? {
          async members(ref: Ref, args: unknown) {
            const { key } = resolve(ref, "room", args);
            return (functions.roomHub?.members(key) ?? []).map((m) => ({
              memberId: m.memberId,
              userId: m.userId,
              presence: fromWire(m.presence),
            }));
          },
        }
      : {}),
  };
  const presence = canRead
    ? {
        async list(ref: Ref, args: unknown) {
          const { key } = resolve(ref, "presence", args);
          return (functions.roomHub?.members(key) ?? []).map((m) => ({
            userId: m.userId as string,
            state: fromWire(m.presence),
            idle: m.idle ?? false,
          }));
        },
      }
    : undefined;
  return { rooms, presence };
}

/** A member's presence from the wire (`null` until it sets one) as the value it stands for. */
const fromWire = (x: unknown): unknown => (x === null || x === undefined ? null : parseValue(JSON.stringify(x)));

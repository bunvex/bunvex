// The rooms' limits (STUDY-164 §3.5, R6), each a knob (STUDY-147).
import { type KnobEnv, knob, secondsKnob } from "@bunvex/core";

export type RoomLimits = {
  payloadBytes: number;
  argsBytes: number;
  roomsPerConnection: number;
  presencePerSecond: number;
  eventsPerSecond: number;
  memberCap: number;
  graceMs: number;
  tickMs: number;
  maxBufferedBytes: number;
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

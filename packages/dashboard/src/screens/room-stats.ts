// What the Overview's Rooms section (AD-43, STUDY-165 §3.2) derives from two stats samples. `rooms`, `members` and
// `connections` are gauges, shown as they are; every other field counts since the server started, shown with its
// rate between the last two samples. Pure, so it is tested without a DOM.
import type { DeploymentStats, RoomStats } from "../data-source.ts";

export type RoomCounter = Exclude<keyof RoomStats, "rooms" | "members" | "connections">;

/**
 * Per-second rate of a rooms counter between two samples; 0 when either has no rooms, time did not move, or the
 * counter went back (the server restarted).
 */
export function roomRate(prev: DeploymentStats, cur: DeploymentStats, counter: RoomCounter): number {
  if (!prev.rooms || !cur.rooms) return 0;
  const dt = (cur.at - prev.at) / 1000;
  const d = cur.rooms[counter] - prev.rooms[counter];
  return dt > 0 && d >= 0 ? d / dt : 0;
}

/** How much a counter grew since the last sample (0 without one, or when it went back). */
export function roomDelta(prev: DeploymentStats | undefined, cur: DeploymentStats, counter: RoomCounter): number {
  if (!prev?.rooms || !cur.rooms) return 0;
  return Math.max(0, cur.rooms[counter] - prev.rooms[counter]);
}

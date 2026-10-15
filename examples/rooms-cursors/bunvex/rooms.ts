import { v } from "bunvex/values";
import { presence, room } from "./_generated/server";

/**
 * A board everyone with its name can join. Each member's presence is its cursor, replaced whole on every update;
 * `wave` is an event: sent to the members who are there now, kept for nobody.
 */
export const board = room({
  args: { board: v.string() },
  presence: { x: v.number(), y: v.number(), name: v.string() },
  events: { wave: { name: v.string() } },
});

/** Who is online on a board: one entry per signed-in user, however many tabs they have open. */
export const online = presence({
  args: { board: v.string() },
  // `canJoin` is optional here: a presence scope is for signed-in users whatever it says.
  state: { name: v.string() },
});

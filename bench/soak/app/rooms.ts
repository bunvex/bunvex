// A room every client joins with a cursor-like presence (rooms are held in memory: AD-42).
import { roomGeneric } from "bunvex/server";
import { v } from "bunvex/values";

export const lobby = roomGeneric({ args: { n: v.number() }, presence: { x: v.number(), y: v.number() } });

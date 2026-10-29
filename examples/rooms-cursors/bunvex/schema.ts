import { defineSchema } from "@bunvex/server";

// Rooms and presence scopes hold no table: their state lives in the server's memory, never in the database.
export default defineSchema({});

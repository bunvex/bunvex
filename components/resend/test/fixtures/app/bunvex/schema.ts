// The app's own table, as upstream's client test app has it: what `onEmailEvent` received.
import { vOnEmailEventArgs } from "@bunvex/resend";
import { defineSchema, defineTable } from "@bunvex/server";

export default defineSchema({
  events: defineTable(vOnEmailEventArgs),
});

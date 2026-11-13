// The core's tables (STUDY-201 §1.2, STUDY-208 §1.1), with v2.0.0's fields and indexes, so a Convex export of them
// imports unchanged. The core keeps no accounts: each sign-in method's component maps its identities to the app's
// users.
//
// - `createdUserIds`: the ids of the app users the core created or signed in, or the app marked as created
//   (`markUserIdCreated`);
// - `sessions`: one row per live session, with the path of the component that authenticated the user (`component`,
//   e.g. `"authPassword"`). It is written only when the session starts and ends, so a query reading it (`getSession`,
//   behind `getAuthUserId`) is not invalidated by refreshes. A session ends once it goes the inactivity timeout without
//   a refresh, or at the latest its max lifetime after its `_creationTime`, under the lifetimes of the call that checks;
// - `refreshTokens`: each refresh token a session handed out and still remembers, by the SHA-256 of the token (the
//   token itself is never stored), and its state:
//   - `issued`: handed out, never presented (sign-in issues the first, each refresh another);
//   - `redeemed`: presented once; presenting it again (a client whose answer was lost) issues another and keeps it so;
//   - `spent`: the redeemed token of before, replaced when a later issued token was redeemed;
//   - `dropped`: an issued token discarded when a sibling was redeemed.
//   A session has at most one redeemed token, and every issued one descends from it. A spent or dropped token
//   presented again means the session's holders diverged (a leaked token), which revokes it. Spent and dropped rows
//   are kept `SPENT_TOKEN_HORIZON_MS` after `retiredAt`, then pruned. Every refresh inserts a row, so when a session
//   last refreshed is its newest issued row's `_creationTime`. A token stores no expiry: it expires the inactivity
//   timeout after its `_creationTime`, under the timeout of the call that checks, so a changed timeout applies to every
//   token already issued.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  createdUserIds: defineTable({
    userId: v.string(),
  }).index("by_userId", ["userId"]),

  sessions: defineTable({
    userId: v.string(),
    component: v.string(),
  }).index("by_user", ["userId"]),

  refreshTokens: defineTable({
    hash: v.string(),
    sessionId: v.id("sessions"),
    state: v.union(v.literal("issued"), v.literal("redeemed"), v.literal("spent"), v.literal("dropped")),
    retiredAt: v.optional(v.number()),
  })
    .index("by_hash", ["hash"])
    .index("by_session_state", ["sessionId", "state", "retiredAt"]),
});

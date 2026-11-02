// The core's tables (STUDY-201 §1.2), with v2's fields and indexes at the pin, so a Convex export of them imports
// unchanged:
//
// - `accounts`: one method identity (`provider`, `providerAccountId`) and the app user id it resolves to; the app owns
//   its users table, the core keeps only the id;
// - `sessions`: one row per live session. It is written only when the session starts and ends, so a query reading it
//   (`getSession`, behind `getAuthUserId`) is not invalidated by refreshes;
// - `refreshTokens`: each refresh token a session handed out and still remembers, by the SHA-256 of the token (the
//   token itself is never stored), and its state:
//   - `issued`: handed out, never presented (sign-in issues the first, each refresh another);
//   - `redeemed`: presented once; presenting it again (a client whose answer was lost) issues another and keeps it so;
//   - `spent`: the redeemed token of before, replaced when a later issued token was redeemed;
//   - `dropped`: an issued token discarded when a sibling was redeemed.
//   A session has at most one redeemed token, and every issued one descends from it. A spent or dropped token
//   presented again means the session's holders diverged (a leaked token), which revokes it. Spent and dropped rows
//   are kept `SPENT_TOKEN_HORIZON_MS` after `retiredAt`, then pruned. Every refresh inserts a row, so when a session
//   last refreshed is its newest issued row's `_creationTime`.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export default defineSchema({
  accounts: defineTable({
    provider: v.string(),
    providerAccountId: v.string(),
    userId: v.string(),
  })
    .index("by_provider_account", ["provider", "providerAccountId"])
    .index("by_user", ["userId"]),

  sessions: defineTable({
    userId: v.string(),
    accountId: v.id("accounts"),
  }).index("by_user", ["userId"]),

  refreshTokens: defineTable({
    hash: v.string(),
    sessionId: v.id("sessions"),
    state: v.union(v.literal("issued"), v.literal("redeemed"), v.literal("spent"), v.literal("dropped")),
    expiresAt: v.number(),
    retiredAt: v.optional(v.number()),
  })
    .index("by_hash", ["hash"])
    .index("by_session_state", ["sessionId", "state", "retiredAt"]),
});

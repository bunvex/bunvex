// The app of the `server/stream` property tests (test/server/stream.property.test.ts): convex-helpers'
// `stream.property.test.ts` schema, whose index keys mix every value type and a missing field.
import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";

export const tenantValidator = v.optional(
  v.union(
    v.null(),
    v.boolean(),
    v.int64(),
    v.number(),
    v.string(),
    v.bytes(),
    v.array(v.number()),
    v.object({ tag: v.number() }),
  ),
);

export default defineSchema({
  rows: defineTable({
    tenant: tenantValidator,
    nested: v.object({ tenant: tenantValidator }),
    bucket: v.number(),
    score: v.number(),
    secret: v.string(),
  })
    .index("tenant_bucket_score", ["tenant", "bucket", "score"])
    .index("tenant_score", ["tenant", "score"])
    .index("nested_tenant", ["nested.tenant", "bucket", "score"]),
  groups: defineTable({ tenant: tenantValidator, bucket: v.number() }).index("tenant_bucket", ["tenant", "bucket"]),
});

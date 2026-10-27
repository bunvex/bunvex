// The app of test/search-after-deploy.test.ts as first deployed: `docs` with no search or vector index. The test
// deploys it again with both (`INDEXED`).
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({ docs: defineTable({ body: v.string(), v: v.array(v.float64()) }) });

import { defineComponent } from "convex/server";
import { v } from "convex/values";

export default defineComponent("envc", { env: { MODE: v.optional(v.string()), KEY: v.optional(v.string()) } });

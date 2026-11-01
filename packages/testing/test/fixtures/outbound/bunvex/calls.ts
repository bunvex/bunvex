// An action that calls an API: what `outbound-fetch.test.ts` answers with `outboundFetch`.
import { action } from "@bunvex/server";
import { v } from "@bunvex/values";

export const call = action({
  args: { url: v.string(), method: v.optional(v.string()), body: v.optional(v.string()) },
  handler: async (_ctx, { url, method, body }) => {
    try {
      const r = await fetch(url, { method, body, headers: { "x-app": "outbound" } });
      return { status: r.status, text: await r.text(), redirected: r.redirected, url: r.url };
    } catch (e) {
      return { error: `${(e as Error).name}: ${(e as Error).message}` };
    }
  },
});

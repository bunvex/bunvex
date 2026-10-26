"use node";
// The "use node" side of test/pbkdf2-cap.test.ts: Node's PBKDF2, which has no bound.
import { actionGeneric } from "convex/server";

export const a = actionGeneric(async (_ctx, a: { iterations: number; bits: number }) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("pw"), "PBKDF2", false, ["deriveBits"]);
  const params = { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(16), iterations: a.iterations };
  try {
    return { ok: (await crypto.subtle.deriveBits(params, key, a.bits)).byteLength };
  } catch (e) {
    return { error: [(e as Error).name, (e as Error).message] };
  }
});

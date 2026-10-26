// The app of test/pbkdf2-cap.test.ts: a PBKDF2 derivation, in each kind of function, its result or its error.
import { actionGeneric, mutationGeneric, queryGeneric } from "convex/server";

type Args = {
  iterations: number;
  bits?: number;
  type?: { name: string; length?: number; hash?: string };
  usage?: string;
};

export async function derive(a: Args) {
  const usages = (a.usage ? [a.usage] : ["deriveBits", "deriveKey"]) as KeyUsage[];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("pw"), "PBKDF2", false, usages);
  const params = { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(16), iterations: a.iterations };
  try {
    if (a.type) {
      const k = await crypto.subtle.deriveKey(
        params,
        key,
        a.type,
        true,
        a.type.name === "HMAC" ? ["sign"] : ["encrypt"],
      );
      return { ok: k.algorithm.name };
    }
    return { ok: (await crypto.subtle.deriveBits(params, key, a.bits ?? 256)).byteLength };
  } catch (e) {
    const err = e as Error;
    return { error: [err.name, err.message] };
  }
}

export const q = queryGeneric(async (_ctx, a: Args) => derive(a));
export const m = mutationGeneric(async (_ctx, a: Args) => derive(a));
export const a = actionGeneric(async (_ctx, a: Args) => derive(a));

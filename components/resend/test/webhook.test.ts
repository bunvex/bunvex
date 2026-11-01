// The webhook's Svix signature check (DV-582: WebCrypto in place of the `svix` package, STUDY-200 §1.14), against
// svix 1.96.1's behaviour: its messages and error class, the order of its checks, the ±300 s tolerance at its exact
// edges, `parseInt`'s reading of the timestamp, several signatures in one header, a secret with or without `whsec_`,
// and the base64 coder's refusals of a bad secret. The signature itself is checked against Svix's published example
// and against one computed here with WebCrypto, independently of the package's own signer.
import { describe, expect, test } from "bun:test";
import { signWebhook, verifyWebhook, WebhookVerificationError, webhookKey } from "../src/client/webhook.ts";

// Svix's documented example: secret, message id, timestamp, body and signature.
const DOC_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const DOC_ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const DOC_TS = 1614265330;
const DOC_BODY = '{"test": 2432232314}';
const DOC_SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";

/** The signature computed here: base64(HMAC-SHA256(base64-decoded secret, `${id}.${ts}.${body}`)), with WebCrypto. */
async function reference(secret: string, id: string, ts: number, body: string) {
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}

const headers = (id: string, ts: string | number, signature: string) => ({
  "svix-id": id,
  "svix-timestamp": String(ts),
  "svix-signature": signature,
});
const at = (seconds: number) => seconds * 1000;

/** The error `verifyWebhook` throws, or null. */
async function refusal(promise: Promise<unknown>): Promise<Error | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    return e as Error;
  }
}

describe("the signature", () => {
  test("matches Svix's published example and a WebCrypto signature computed here", async () => {
    const key = webhookKey(DOC_SECRET);
    expect(await signWebhook(key, DOC_ID, DOC_TS, DOC_BODY)).toBe(DOC_SIGNATURE);
    expect(await reference(DOC_SECRET, DOC_ID, DOC_TS, DOC_BODY)).toBe(DOC_SIGNATURE);
    const other = `whsec_${btoa("another secret, 32 bytes long!!!")}`;
    expect(await signWebhook(webhookKey(other), "msg_2", 1_800_000_000, '{"a":[1,2]}')).toBe(
      await reference(other, "msg_2", 1_800_000_000, '{"a":[1,2]}'),
    );
  });

  test("a valid signature returns the parsed body; the prefix is optional", async () => {
    const parsed = await verifyWebhook(
      webhookKey(DOC_SECRET),
      DOC_BODY,
      headers(DOC_ID, DOC_TS, DOC_SIGNATURE),
      at(DOC_TS),
    );
    expect(parsed).toEqual({ test: 2432232314 });
    const bare = webhookKey(DOC_SECRET.slice("whsec_".length));
    expect(await verifyWebhook(bare, DOC_BODY, headers(DOC_ID, DOC_TS, DOC_SIGNATURE), at(DOC_TS))).toEqual({
      test: 2432232314,
    });
  });

  test("any of several space-separated signatures may match; only v1 ones are compared", async () => {
    const key = webhookKey(DOC_SECRET);
    const sig = DOC_SIGNATURE.slice(3);
    for (const header of [`v1,AAAA ${DOC_SIGNATURE}`, `v2,${sig} ${DOC_SIGNATURE}`, `${DOC_SIGNATURE} v1,zzz`]) {
      expect(await verifyWebhook(key, DOC_BODY, headers(DOC_ID, DOC_TS, header), at(DOC_TS))).toEqual({
        test: 2432232314,
      });
    }
    for (const header of [`v2,${sig}`, sig, `v1,${sig}x`, `v1, ${sig}`, "v1"]) {
      const e = await refusal(verifyWebhook(key, DOC_BODY, headers(DOC_ID, DOC_TS, header), at(DOC_TS)));
      expect([header, e?.message]).toEqual([header, "No matching signature found"]);
    }
  });

  test("another body, id or timestamp does not match", async () => {
    const key = webhookKey(DOC_SECRET);
    for (const [id, ts, body] of [
      [DOC_ID, DOC_TS, '{"test": 2432232315}'],
      ["msg_other", DOC_TS, DOC_BODY],
      [DOC_ID, DOC_TS + 1, DOC_BODY],
    ] as const) {
      const e = await refusal(verifyWebhook(key, body, headers(id, ts, DOC_SIGNATURE), at(DOC_TS)));
      expect(e).toBeInstanceOf(WebhookVerificationError);
      expect(e?.message).toBe("No matching signature found");
    }
  });
});

describe("svix's refusals, in its order", () => {
  const key = webhookKey(DOC_SECRET);
  const check = (h: ReturnType<typeof headers>, now = at(DOC_TS), body = DOC_BODY) =>
    refusal(verifyWebhook(key, body, h, now));

  test("Missing required headers: any of the three empty", async () => {
    for (const h of [
      headers("", DOC_TS, DOC_SIGNATURE),
      headers(DOC_ID, "", DOC_SIGNATURE),
      headers(DOC_ID, DOC_TS, ""),
      headers("", "", ""),
    ]) {
      const e = await check(h);
      expect(e).toBeInstanceOf(WebhookVerificationError);
      expect(e?.name).toBe("WebhookVerificationError");
      expect(e?.message).toBe("Missing required headers");
    }
  });

  test("Invalid Signature Headers: a timestamp parseInt cannot read; one it can is read as far as it goes", async () => {
    for (const ts of ["soon", "abc123", " ", "-"]) {
      const e = await check(headers(DOC_ID, ts, DOC_SIGNATURE));
      expect([ts, e?.message]).toEqual([ts, "Invalid Signature Headers"]);
      expect(e?.name).toBe("WebhookVerificationError");
    }
    // `1614265330abc` reads as 1614265330, and is signed as that number.
    expect(await verifyWebhook(key, DOC_BODY, headers(DOC_ID, `${DOC_TS}abc`, DOC_SIGNATURE), at(DOC_TS))).toEqual({
      test: 2432232314,
    });
  });

  test("Message timestamp too old / too new, past 300 s either way, checked before the signature", async () => {
    const old = await check(headers(DOC_ID, DOC_TS, "v1,wrong"), at(DOC_TS + 301));
    expect(old?.message).toBe("Message timestamp too old");
    expect(old?.name).toBe("WebhookVerificationError");
    const future = await check(headers(DOC_ID, DOC_TS, "v1,wrong"), at(DOC_TS - 301));
    expect(future?.message).toBe("Message timestamp too new");
    // The edges are inside: 300 s either way, the clock read in whole seconds.
    expect(await check(headers(DOC_ID, DOC_TS, DOC_SIGNATURE), at(DOC_TS + 300) + 999)).toBeNull();
    expect(await check(headers(DOC_ID, DOC_TS, DOC_SIGNATURE), at(DOC_TS - 300))).toBeNull();
  });

  test("a matching signature over a body that is not JSON throws JSON's error", async () => {
    const sig = await signWebhook(key, DOC_ID, DOC_TS, "{");
    const e = await check(headers(DOC_ID, DOC_TS, sig), at(DOC_TS), "{");
    expect(e).toBeInstanceOf(SyntaxError);
  });
});

describe("the secret", () => {
  test("base64 after an optional whsec_ prefix", () => {
    expect([...webhookKey("whsec_AQID")]).toEqual([1, 2, 3]);
    expect([...webhookKey("AQID")]).toEqual([1, 2, 3]);
    expect([...webhookKey("AQI=")]).toEqual([1, 2]);
    // svix's coder decodes what an unpadded tail holds.
    expect([...webhookKey("AQIDBA")]).toEqual([1, 2, 3, 4]);
  });

  test("the base64 coder's refusals", () => {
    expect(() => webhookKey("whsec_")).toThrow("Base64Coder: incorrect padding");
    expect(() => webhookKey("AQ")).toThrow("Base64Coder: incorrect padding");
    expect(() => webhookKey("A===")).toThrow("Base64Coder: incorrect padding");
    expect(() => webhookKey("AQ*D")).toThrow("Base64Coder: incorrect characters for decoding");
    expect(() => webhookKey("AQ-_")).toThrow("Base64Coder: incorrect characters for decoding");
  });
});

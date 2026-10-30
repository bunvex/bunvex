// A Resend webhook's Svix signature, checked with WebCrypto (DV-582) where Convex's resend 0.2.10 calls the `svix`
// package's `Webhook#verify` (STUDY-200 §1.14). The same steps and messages as svix 1.96.1 over standardwebhooks
// 1.0.0:
//
// - the secret loses a `whsec_` prefix and is base64-decoded, before the request is read (a bad one throws there);
// - an empty `svix-id`, `svix-timestamp` or `svix-signature` → `Missing required headers`;
// - the timestamp, read as `parseInt(…, 10)` in seconds: not a number → `Invalid Signature Headers`; more than 300 s
//   behind the clock → `Message timestamp too old`; more than 300 s ahead → `Message timestamp too new`;
// - the signature is base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)), the timestamp as parsed; the header holds
//   space-separated `<version>,<signature>` entries, and only `v1` ones are compared, in constant time; none equal →
//   `No matching signature found`;
// - then the body is parsed as JSON.
//
// Each refusal is a `WebhookVerificationError`, the class name svix gives it.

/** How far a webhook's timestamp may be from the clock, in seconds. */
const TOLERANCE_SECONDS = 5 * 60;
const SECRET_PREFIX = "whsec_";

/** A webhook refused: missing headers, a stale or future timestamp, or no matching signature. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * The secret's key bytes: base64 after an optional `whsec_` prefix, decoded as svix's base64 coder decodes it: at
 * least 4 characters and at most 2 of padding, a length not a multiple of 4 decoding what its groups hold (a lone
 * last character is dropped), and its messages when it refuses.
 */
export function webhookKey(secret: string): Uint8Array {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const padding = encoded.length - encoded.replace(/=+$/, "").length;
  if (encoded.length < 4 || padding > 2) throw new Error("Base64Coder: incorrect padding");
  const digits = encoded.slice(0, encoded.length - padding);
  const used = digits.length % 4 === 1 ? digits.slice(0, -1) : digits;
  const bytes: number[] = [];
  let bits = 0;
  let count = 0;
  for (const char of used) {
    const value = BASE64_DIGITS.indexOf(char);
    if (value < 0) throw new Error("Base64Coder: incorrect characters for decoding");
    bits = ((bits << 6) | value) & 0xffff;
    count += 6;
    if (count >= 8) {
      count -= 8;
      bytes.push((bits >> count) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** The `v1,<base64>` signature of a message `id` sent at `timestamp` (seconds) with `body`. */
export async function signWebhook(key: Uint8Array, id: string, timestamp: number, body: string): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  let binary = "";
  for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte);
  return `v1,${btoa(binary)}`;
}

/** Whether two strings' UTF-8 bytes are equal, looking at every byte whatever the first difference. */
function sameBytes(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

/** The Svix headers of a webhook request. */
export type SvixHeaders = { "svix-id": string; "svix-timestamp": string; "svix-signature": string };

/**
 * Check a webhook's signature with the key from {@link webhookKey}, and return its parsed body.
 * Throws a {@link WebhookVerificationError} when it does not hold, at the clock's time `now` (ms).
 */
export async function verifyWebhook(
  key: Uint8Array,
  body: string,
  headers: SvixHeaders,
  now: number = Date.now(),
): Promise<unknown> {
  const id = headers["svix-id"];
  const timestampHeader = headers["svix-timestamp"];
  const signatures = headers["svix-signature"];
  if (!signatures || !id || !timestampHeader) throw new WebhookVerificationError("Missing required headers");

  const nowSeconds = Math.floor(now / 1000);
  const timestamp = Number.parseInt(timestampHeader, 10);
  if (Number.isNaN(timestamp)) throw new WebhookVerificationError("Invalid Signature Headers");
  if (nowSeconds - timestamp > TOLERANCE_SECONDS) throw new WebhookVerificationError("Message timestamp too old");
  if (timestamp > nowSeconds + TOLERANCE_SECONDS) throw new WebhookVerificationError("Message timestamp too new");

  const expected = (await signWebhook(key, id, timestamp, body)).slice("v1,".length);
  for (const entry of signatures.split(" ")) {
    const [version, signature] = entry.split(",");
    if (version === "v1" && sameBytes(signature ?? "", expected)) return JSON.parse(body);
  }
  throw new WebhookVerificationError("No matching signature found");
}

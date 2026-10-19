// KBKDF in counter mode with HMAC-SHA256 (NIST SP 800-108), as Convex's keybroker derives a key per purpose
// from the instance secret (crates/keybroker/src/encryptor.rs `derive_from_secret`, aws-lc's
// `kbkdf_ctr_hmac`): block i is HMAC(secret, i as a 32-bit big-endian counter ‖ info), from i = 1.
import { createHmac } from "node:crypto";

export function kbkdfCtrHmacSha256(secret: Uint8Array, info: Uint8Array | string, length: number): Uint8Array {
  const label = typeof info === "string" ? Buffer.from(info, "utf8") : Buffer.from(info);
  const out = Buffer.alloc(length);
  const counter = Buffer.alloc(4);
  for (let i = 1, at = 0; at < length; i++) {
    counter.writeUInt32BE(i);
    const block = createHmac("sha256", secret).update(counter).update(label).digest();
    at += block.copy(out, at, 0, Math.min(block.length, length - at));
  }
  return new Uint8Array(out);
}

// 32 bytes as 64 hex digits, after one optional `0x` / `0X`: Convex's `DeploymentSecret::try_from` decodes with
// `const_hex::decode`, which drops that prefix (crates/keybroker/src/secret.rs; STUDY-172 §7).
const HEX_SECRET = /^(?:0[xX])?([0-9a-fA-F]{64})$/;

/** The instance secret's bytes, as Convex reads it: 32 bytes written as 64 hex digits, `0x` allowed. Any other
 *  string (a secret given before keys needed its bytes) is taken as its UTF-8 bytes. */
export function instanceSecretBytes(secret: string): Uint8Array {
  const hex = HEX_SECRET.exec(secret)?.[1];
  return hex ? new Uint8Array(Buffer.from(hex, "hex")) : new TextEncoder().encode(secret);
}

/** One spelling per secret: a hex secret as its 64 lowercase digits without `0x` (as Convex's `Display` writes
 *  its bytes back), so every spelling of the same bytes derives the same keys; any other string as it is. */
export function canonicalInstanceSecret(secret: string): string {
  return HEX_SECRET.exec(secret)?.[1]?.toLowerCase() ?? secret;
}

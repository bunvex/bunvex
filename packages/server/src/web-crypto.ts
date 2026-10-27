// `crypto` for functions, with the bound Convex's runtime puts on PBKDF2 (crates/webcrypto/src/pbkdf2.rs
// `derive_bits`, at 8856603): `deriveBits` and `deriveKey` refuse a derivation whose iterations times its output's
// bytes (64 at least) pass 150 000 000, about a second of CPU, with an `OperationError` "too many iterations"; and,
// checked just before it, a length past 64 KiB ("cannot generate more than 524288 bits"). Bun's `crypto.subtle` has
// neither bound. Both are checked once Convex's earlier checks would have passed (the key's algorithm and usage,
// iterations above 0, a length that is a multiple of 8); anything else goes to Bun as it is, and fails or derives as
// Bun's does. A `"use node"` action keeps the host's `crypto`, as Node's has no
// bound either.
//
// Every method is the host's, called on the host's objects: Bun's own check their receiver, and the host's are the
// ones the determinism layer replaced (`installDeterminism`).

/** Convex's bound on `iterations × max(bytes, 64)`. */
export const PBKDF2_MAX_WORK = 150_000_000;
/** The most bits a derivation may give in Convex's runtime (`DERIVE_BITS_MAX`, 64 KiB). */
const DERIVE_BITS_MAX = 8 * 65536;

type Params = { name?: unknown; iterations?: unknown; hash?: unknown; length?: unknown };

const nameOf = (a: unknown): string | undefined =>
  typeof a === "string" ? a : a && typeof a === "object" ? String((a as Params).name ?? "") : undefined;

/** The PBKDF2 parameters' iterations, as WebIDL's unsigned long takes them, or null when Bun would refuse them. */
function iterationsOf(algorithm: unknown): number | null {
  if (!algorithm || typeof algorithm !== "object") return null;
  const n = Math.trunc(Number((algorithm as Params).iterations));
  return Number.isFinite(n) && n > 0 && n <= 0xffff_ffff ? n : null;
}

/** The bits `deriveKey` derives for `type` (Convex's `get_key_length` for HMAC and AES), or null when it fails first. */
function derivedKeyBits(type: unknown): number | null {
  const name = nameOf(type)?.toUpperCase();
  const p = (type && typeof type === "object" ? type : {}) as Params;
  if (name === "AES-GCM" || name === "AES-CBC" || name === "AES-CTR") {
    const length = Number(p.length);
    return [128, 192, 256].includes(length) ? length : null;
  }
  if (name === "HMAC") {
    if (p.length === undefined) {
      const hash = nameOf(p.hash)?.toUpperCase();
      return hash === "SHA-1" || hash === "SHA-256" ? 512 : hash === "SHA-384" || hash === "SHA-512" ? 1024 : null;
    }
    const length = Math.trunc(Number(p.length));
    return length > 0 && length % 8 === 0 ? length : null;
  }
  return null;
}

/** Convex's refusal, when the PBKDF2 derivation of `bits` from `key` with `algorithm` reaches past the bound. */
export function pbkdf2Refusal(
  algorithm: unknown,
  key: unknown,
  bits: number | null,
  usage: "deriveBits" | "deriveKey",
): DOMException | null {
  if (nameOf(algorithm)?.toUpperCase() !== "PBKDF2") return null;
  if (!(key instanceof CryptoKey) || key.algorithm.name !== "PBKDF2" || !key.usages.includes(usage)) return null;
  const iterations = iterationsOf(algorithm);
  if (iterations === null || bits === null || bits % 8 !== 0) return null;
  // Convex's earlier bound, on the length alone (Bun derives any length).
  if (bits > DERIVE_BITS_MAX)
    return new DOMException(`cannot generate more than ${DERIVE_BITS_MAX} bits`, "OperationError");
  if (iterations * Math.max(bits / 8, 64) <= PBKDF2_MAX_WORK) return null;
  return new DOMException("too many iterations", "OperationError");
}

const SUBTLE_METHODS = [
  "decrypt",
  "deriveBits",
  "deriveKey",
  "digest",
  "encrypt",
  "exportKey",
  "generateKey",
  "importKey",
  "sign",
  "unwrapKey",
  "verify",
  "wrapKey",
] as const;

/** A function context's `crypto`: the host's, with PBKDF2's bound on `subtle.deriveBits` and `subtle.deriveKey`. */
export function isolateCrypto(host: Crypto = globalThis.crypto): Crypto {
  const hostSubtle = host.subtle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const subtle = Object.create(Object.getPrototypeOf(host.subtle)) as Record<string, unknown>;
  for (const m of SUBTLE_METHODS) subtle[m] = (...args: unknown[]) => hostSubtle[m]!(...args);
  subtle.deriveBits = (...args: unknown[]) => {
    const [algorithm, key, length] = args;
    const bits = typeof length === "number" ? length : null;
    const refused = pbkdf2Refusal(algorithm, key, bits, "deriveBits");
    return refused ? Promise.reject(refused) : hostSubtle.deriveBits!(...args);
  };
  subtle.deriveKey = (...args: unknown[]) => {
    const [algorithm, key, type] = args;
    const refused = pbkdf2Refusal(algorithm, key, derivedKeyBits(type), "deriveKey");
    return refused ? Promise.reject(refused) : hostSubtle.deriveKey!(...args);
  };
  const out = Object.create(Object.getPrototypeOf(host)) as Record<string, unknown>;
  out.getRandomValues = (...args: unknown[]) =>
    (host.getRandomValues as (...a: unknown[]) => unknown).apply(host, args);
  out.randomUUID = () => host.randomUUID();
  Object.defineProperty(out, "subtle", { value: subtle, enumerable: true });
  return out as unknown as Crypto;
}

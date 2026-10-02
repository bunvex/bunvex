// Admin keys (STUDY-34), byte for byte Convex's (crates/keybroker): `{instance name}|{hex}`, the hex part
// `version (1) ‖ nonce (12) ‖ AES-128-GCM-SIV(AdminKey proto, AAD = [version]) ‖ tag (16)`, the cipher's key
// derived from the instance secret by KBKDF-CTR-HMAC-SHA256 with the purpose "admin key". A key issued by
// Convex for a name and secret checks out here with the same name and secret, and the reverse.
//
// Bun's crypto has AES-GCM but not AES-GCM-SIV, so it is written here from RFC 8452 over AES-128-ECB
// (POLYVAL, the tag, CTR mode with a 32-bit little-endian counter). Keys are a few dozen bytes and a checked
// key is cached by its string, so this costs one decryption per new key.
import { createCipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { instanceSecretBytes, kbkdfCtrHmacSha256 } from "@bunvex/core";

/** Convex's ADMIN_KEY_VERSION: the first byte of a key, also the cipher's associated data. */
export const ADMIN_KEY_VERSION = 1;
/** The purpose the admin key cipher's key is derived for (Convex's `Purpose::ADMIN_KEY`). */
export const ADMIN_KEY_PURPOSE = "admin key";

/** Convex's `DeploymentOp` (crates/keybroker/src/operations.rs), in its order. */
export const DEPLOYMENT_OPS = [
  "Deploy",
  "ViewEnvironmentVariables",
  "WriteEnvironmentVariables",
  "PauseDeployment",
  "UnpauseDeployment",
  "ViewLogs",
  "ViewMetrics",
  "ViewIntegrations",
  "WriteIntegrations",
  "ViewData",
  "WriteData",
  "ViewBackups",
  "CreateBackups",
  "DownloadBackups",
  "DeleteBackups",
  "ImportBackups",
  "ActAsUser",
  "RunInternalQueries",
  "RunInternalMutations",
  "RunInternalActions",
  "RunTestQuery",
  "ViewAuditLog",
  "ViewUsageLimits",
  "WriteUsageLimits",
  "ViewUsage",
  "UseAiGateway",
] as const;
export type DeploymentOp = (typeof DEPLOYMENT_OPS)[number];

/** Convex's `read_only_operations()`: what a read-only key may do. */
export const READ_ONLY_OPERATIONS: readonly DeploymentOp[] = [
  "ViewEnvironmentVariables",
  "ViewLogs",
  "ViewMetrics",
  "ViewIntegrations",
  "ViewData",
  "ViewBackups",
  "DownloadBackups",
  "RunInternalQueries",
  "RunTestQuery",
  "ViewAuditLog",
  "ViewUsageLimits",
  "ViewUsage",
];

/** A checked admin key's identity: an admin (member) or the system. `allowedOps` empty means every one. */
export type AdminKeyIdentity =
  | { kind: "admin"; memberId: number; readOnly: boolean; allowedOps: readonly DeploymentOp[]; issuedS: number }
  | { kind: "system"; issuedS: number };

/** The key was not issued for this instance, or is not a key at all. As Convex: 401 `BadAdminKey`. */
export class BadAdminKeyError extends Error {
  readonly status = 401;
  readonly code = "BadAdminKey";
  constructor(readonly reason: string) {
    super("The provided admin key was invalid for this instance");
    this.name = "BadAdminKeyError";
  }
}

// ---- AES-128-GCM-SIV (RFC 8452) -------------------------------------------------------------------------

const aesBlock = (key: Uint8Array, block: Uint8Array) => {
  const c = createCipheriv("aes-128-ecb", key, null);
  c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(block), c.final()]));
};
const leToBig = (b: Uint8Array) => {
  let x = 0n;
  for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]!);
  return x;
};
const bigToLe = (x: bigint) => {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
};
/** POLYVAL's field: x^128 + x^127 + x^126 + x^121 + 1, little-endian. */
const POLY = (1n << 128n) | (1n << 127n) | (1n << 126n) | (1n << 121n) | 1n;
/** a · b · x^-128 in POLYVAL's field. */
function dot(a: bigint, b: bigint) {
  let c = 0n;
  for (let i = 0n; i < 128n; i++) if ((b >> i) & 1n) c ^= a << i;
  for (let i = 0; i < 128; i++) {
    if (c & 1n) c ^= POLY;
    c >>= 1n;
  }
  return c;
}
function polyval(h: Uint8Array, data: Uint8Array) {
  const H = leToBig(h);
  let s = 0n;
  for (let i = 0; i < data.length; i += 16) s = dot(s ^ leToBig(data.subarray(i, i + 16)), H);
  return bigToLe(s);
}
const padded = (b: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(b.length / 16) * 16);
  out.set(b);
  return out;
};
function sivKeys(key: Uint8Array, nonce: Uint8Array) {
  const half = (i: number) => {
    const b = new Uint8Array(16);
    new DataView(b.buffer).setUint32(0, i, true);
    b.set(nonce, 4);
    return aesBlock(key, b).subarray(0, 8);
  };
  const auth = new Uint8Array(16);
  auth.set(half(0), 0);
  auth.set(half(1), 8);
  const enc = new Uint8Array(16);
  enc.set(half(2), 0);
  enc.set(half(3), 8);
  return { auth, enc };
}
function sivTag(keys: { auth: Uint8Array; enc: Uint8Array }, nonce: Uint8Array, aad: Uint8Array, pt: Uint8Array) {
  const lengths = new Uint8Array(16);
  const dv = new DataView(lengths.buffer);
  dv.setBigUint64(0, BigInt(aad.length * 8), true);
  dv.setBigUint64(8, BigInt(pt.length * 8), true);
  const pa = padded(aad);
  const pp = padded(pt);
  const all = new Uint8Array(pa.length + pp.length + 16);
  all.set(pa, 0);
  all.set(pp, pa.length);
  all.set(lengths, pa.length + pp.length);
  const s = polyval(keys.auth, all);
  for (let i = 0; i < 12; i++) s[i]! ^= nonce[i]!;
  s[15]! &= 0x7f;
  return aesBlock(keys.enc, s);
}
function sivCtr(key: Uint8Array, tag: Uint8Array, data: Uint8Array) {
  const block = new Uint8Array(tag);
  block[15]! |= 0x80;
  const dv = new DataView(block.buffer);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) {
    const ks = aesBlock(key, block);
    for (let j = 0; j < 16 && i + j < data.length; j++) out[i + j] = data[i + j]! ^ ks[j]!;
    dv.setUint32(0, (dv.getUint32(0, true) + 1) >>> 0, true);
  }
  return out;
}

/** AES-128-GCM-SIV: the ciphertext followed by its 16-byte tag. */
export function aes128GcmSivSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array) {
  const keys = sivKeys(key, nonce);
  const tag = sivTag(keys, nonce, aad, plaintext);
  const out = new Uint8Array(plaintext.length + 16);
  out.set(sivCtr(keys.enc, tag, plaintext));
  out.set(tag, plaintext.length);
  return out;
}

/** The plaintext, or null when the tag does not match. */
export function aes128GcmSivOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array) {
  if (sealed.length < 16) return null;
  const keys = sivKeys(key, nonce);
  const tag = sealed.subarray(sealed.length - 16);
  const pt = sivCtr(keys.enc, tag, sealed.subarray(0, sealed.length - 16));
  return timingSafeEqual(sivTag(keys, nonce, aad, pt), tag) ? pt : null;
}

// ---- The AdminKey proto (crates/pb/protos/convex_keys.proto), proto3 -----------------------------------

type AdminKeyProto = {
  instanceName?: string;
  issuedS: number;
  identity?: { memberId: number } | { system: true };
  isReadOnly: boolean;
};

function varint(n: bigint, out: number[]) {
  while (n >= 0x80n) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
}

/** As prost encodes it: fields in number order; proto3 defaults left out; the oneof always written. */
export function encodeAdminKeyProto(p: AdminKeyProto): Uint8Array {
  const out: number[] = [];
  if (p.instanceName !== undefined) {
    const name = new TextEncoder().encode(p.instanceName);
    out.push(0x0a);
    varint(BigInt(name.length), out);
    out.push(...name);
  }
  if (p.issuedS) {
    out.push(0x10);
    varint(BigInt(p.issuedS), out);
  }
  if (p.identity && "memberId" in p.identity) {
    out.push(0x18);
    varint(BigInt(p.identity.memberId), out);
  } else if (p.identity) out.push(0x22, 0x00);
  if (p.isReadOnly) out.push(0x28, 0x01);
  return new Uint8Array(out);
}

export function decodeAdminKeyProto(b: Uint8Array): AdminKeyProto {
  const p: AdminKeyProto = { issuedS: 0, isReadOnly: false };
  let i = 0;
  const readVarint = () => {
    let x = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (i >= b.length || shift > 63n) throw new Error("truncated varint");
      const byte = b[i++]!;
      x |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return x;
    }
  };
  while (i < b.length) {
    const tag = Number(readVarint());
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const v = readVarint();
      if (field === 2) p.issuedS = Number(v);
      else if (field === 3) p.identity = { memberId: Number(v) };
      else if (field === 5) p.isReadOnly = v !== 0n;
    } else if (wire === 2) {
      const len = Number(readVarint());
      if (i + len > b.length) throw new Error("truncated field");
      const bytes = b.subarray(i, i + len);
      i += len;
      if (field === 1) p.instanceName = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      else if (field === 4) p.identity = { system: true };
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return p;
}

// ---- Keys ---------------------------------------------------------------------------------------------

/**
 * Convex's `remove_type_prefix` (the header layer): `prod:name|key` and `dev:name|key` become `name|key`;
 * `preview:…|key` and `project:…|key` become just `key`.
 */
export function removeTypePrefix(key: string): string {
  const bar = key.indexOf("|");
  if (bar === -1) return key;
  const prefix = key.slice(0, bar);
  const colon = prefix.indexOf(":");
  if (colon === -1) return key;
  const type = prefix.slice(0, colon).toLowerCase();
  if (type === "preview" || type === "project") return key.slice(bar + 1);
  return `${prefix.slice(colon + 1)}|${key.slice(bar + 1)}`;
}

/** The admin key cipher's key for an instance secret (KBKDF, purpose "admin key"). */
export const adminKeyCipherKey = (instanceSecret: string) =>
  kbkdfCtrHmacSha256(instanceSecretBytes(instanceSecret), ADMIN_KEY_PURPOSE, 16);

export type IssueOptions = {
  instanceName: string;
  /** The cipher's key (`adminKeyCipherKey(secret)`, or the engine's `derivedKey("admin key")`). */
  cipherKey: Uint8Array;
  /** A system key (Convex's `issue_system_key`) instead of a member's. */
  system?: boolean;
  /** Default 0, as Convex's self-hosted `generate_key`. */
  memberId?: number;
  readOnly?: boolean;
  /** Seconds since the epoch; default now. */
  issuedS?: number;
  /** Tests only: a fixed nonce. */
  nonce?: Uint8Array;
};

/** Convex's `issue_key`: `name|hex(1 ‖ nonce ‖ sealed proto)`. */
export function issueAdminKey(o: IssueOptions): string {
  const nonce = o.nonce ?? new Uint8Array(randomBytes(12));
  const proto = encodeAdminKeyProto({
    issuedS: o.issuedS ?? Math.floor(Date.now() / 1000),
    identity: o.system ? { system: true } : { memberId: o.memberId ?? 0 },
    isReadOnly: !!o.readOnly,
  });
  const sealed = aes128GcmSivSeal(o.cipherKey, nonce, Uint8Array.of(ADMIN_KEY_VERSION), proto);
  const bytes = new Uint8Array(1 + 12 + sealed.length);
  bytes[0] = ADMIN_KEY_VERSION;
  bytes.set(nonce, 1);
  bytes.set(sealed, 13);
  return `${o.instanceName}|${Buffer.from(bytes).toString("hex")}`;
}

/**
 * Convex's `check_admin_key`: the name before `|` (its type prefix stripped) or, without one, the name inside
 * the key must be this instance's; the key must decrypt and carry `issued_s` and an identity. Keys never
 * expire. Throws `BadAdminKeyError`.
 */
export function checkAdminKey(key: string, instanceName: string, cipherKey: Uint8Array): AdminKeyIdentity {
  const bar = key.indexOf("|");
  let name: string | undefined;
  let hex = key;
  if (bar !== -1) {
    const prefix = key.slice(0, bar);
    const colon = prefix.indexOf(":");
    name = colon === -1 ? prefix : prefix.slice(colon + 1);
    hex = key.slice(bar + 1);
  }
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new BadAdminKeyError("the key is not hex");
  const bytes = new Uint8Array(Buffer.from(hex, "hex"));
  if (bytes[0] !== ADMIN_KEY_VERSION) throw new BadAdminKeyError(`invalid message version ${bytes[0]}`);
  if (bytes.length < 1 + 12 + 16) throw new BadAdminKeyError("the key is too short");
  const pt = aes128GcmSivOpen(cipherKey, bytes.subarray(1, 13), Uint8Array.of(ADMIN_KEY_VERSION), bytes.subarray(13));
  if (!pt) throw new BadAdminKeyError("the key does not decrypt with this instance's secret");
  let proto: AdminKeyProto;
  try {
    proto = decodeAdminKeyProto(pt);
  } catch (e) {
    throw new BadAdminKeyError(`the key's contents do not decode: ${(e as Error).message}`);
  }
  const keyName = name ?? (proto.instanceName || undefined);
  if (keyName === undefined) throw new BadAdminKeyError("Invalid admin key format");
  if (keyName !== instanceName) throw new BadAdminKeyError(`Key is for invalid instance ${keyName}`);
  if (!proto.issuedS) throw new BadAdminKeyError("Proto missing issued_s");
  if (!proto.identity) throw new BadAdminKeyError("Proto missing identity");
  if ("system" in proto.identity) return { kind: "system", issuedS: proto.issuedS };
  return {
    kind: "admin",
    memberId: proto.identity.memberId,
    readOnly: proto.isReadOnly,
    allowedOps: proto.isReadOnly ? READ_ONLY_OPERATIONS : [],
    issuedS: proto.issuedS,
  };
}

/** Whether an identity may perform `op` (Convex's `is_operation_allowed`: an empty list allows all). */
export const allows = (id: AdminKeyIdentity, op: DeploymentOp) =>
  id.kind === "system" || id.allowedOps.length === 0 || id.allowedOps.includes(op);

/** One instance's key checker, with the checked keys cached (a key's verdict never changes). */
export class AdminKeys {
  private cache = new Map<string, AdminKeyIdentity | BadAdminKeyError>();
  constructor(
    readonly instanceName: string,
    private cipherKey: Uint8Array,
    private maxCached = 1024,
  ) {}

  check(key: string): AdminKeyIdentity {
    let v = this.cache.get(key);
    if (v === undefined) {
      try {
        v = checkAdminKey(key, this.instanceName, this.cipherKey);
      } catch (e) {
        if (!(e instanceof BadAdminKeyError)) throw e;
        v = e;
      }
      if (this.cache.size >= this.maxCached) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, v);
    }
    if (v instanceof BadAdminKeyError) throw v;
    return v;
  }

  issue(o: Omit<IssueOptions, "instanceName" | "cipherKey"> = {}) {
    return issueAdminKey({ ...o, instanceName: this.instanceName, cipherKey: this.cipherKey });
  }
}

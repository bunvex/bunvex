// Admin keys (STUDY-34), byte for byte Convex's (crates/keybroker): `{instance name}|{hex}`, the hex part
// `version (1) ‖ nonce (12) ‖ AES-128-GCM-SIV(AdminKey proto, AAD = [version]) ‖ tag (16)`, the cipher's key
// derived from the instance secret by KBKDF-CTR-HMAC-SHA256 with the purpose "admin key". A key issued by
// Convex for a name and secret checks out here with the same name and secret, and the reverse.
//
// Bun's crypto has AES-GCM but not AES-GCM-SIV, so it is written here from RFC 8452 over AES-128-ECB
// (POLYVAL, the tag, CTR mode with a 32-bit little-endian counter). Keys are a few dozen bytes and a checked
// key is cached by its string, so this costs one decryption per new key.
import { createCipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { aes128GcmSivOpen, aes128GcmSivSeal, instanceSecretBytes, kbkdfCtrHmacSha256 } from "@bunvex/core";

export { aes128GcmSivOpen, aes128GcmSivSeal };

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

// ---- Operations and access errors ---------------------------------------------------------------------

/** How Convex names each operation in `OperationNotPermitted` (crates/roles `deployment_op_action`). */
export const OP_ACTIONS: Record<DeploymentOp, string> = {
  Deploy: "deployment:deploy",
  ViewEnvironmentVariables: "deployment:env:view",
  WriteEnvironmentVariables: "deployment:env:write",
  PauseDeployment: "deployment:pause",
  UnpauseDeployment: "deployment:unpause",
  ViewLogs: "deployment:logs:view",
  ViewMetrics: "deployment:metrics:view",
  ViewIntegrations: "deployment:integrations:view",
  WriteIntegrations: "deployment:integrations:write",
  ViewData: "deployment:data:view",
  WriteData: "deployment:data:write",
  ViewBackups: "deployment:backups:view",
  CreateBackups: "deployment:backups:create",
  DownloadBackups: "deployment:backups:download",
  DeleteBackups: "deployment:backups:delete",
  ImportBackups: "deployment:backups:import",
  ActAsUser: "deployment:functions:actAsUser",
  RunInternalQueries: "deployment:functions:runInternalQueries",
  RunInternalMutations: "deployment:functions:runInternalMutations",
  RunInternalActions: "deployment:functions:runInternalActions",
  RunTestQuery: "deployment:functions:runTestQuery",
  ViewAuditLog: "deployment:auditLog:view",
  ViewUsageLimits: "deployment:usageLimits:view",
  WriteUsageLimits: "deployment:usageLimits:write",
  ViewUsage: "deployment:usage:view",
  UseAiGateway: "deployment:aiGateway:use",
};

/** An admin without the operation: 403 `OperationNotPermitted`, Convex's message. */
export class OperationNotPermittedError extends Error {
  readonly status = 403;
  readonly code = "OperationNotPermitted";
  constructor(readonly op: DeploymentOp) {
    super(`You do not have permission to perform this operation (${OP_ACTIONS[op]}).`);
    this.name = "OperationNotPermittedError";
  }
}

/** No admin where one is required (Convex's `bad_admin_key_error`): 403 `BadDeployKey`. */
export class BadDeployKeyError extends Error {
  readonly status = 403;
  readonly code = "BadDeployKey";
  constructor(instanceName?: string) {
    super(
      instanceName === undefined
        ? "The provided deploy key was invalid for this deployment. Double check that the environment this key was generated for matches the desired deployment."
        : `The provided deploy key was invalid for deployment '${instanceName}'. Double check that the environment this key was generated for matches the desired deployment.`,
    );
    this.name = "BadDeployKeyError";
  }
}

/** A malformed `Authorization` header (Convex: 400 `HeaderParseFailure`). */
export class HeaderParseError extends Error {
  readonly status = 400;
  readonly code = "HeaderParseFailure";
  constructor() {
    super("Malformed Authorization header.");
    this.name = "HeaderParseError";
  }
}

const STRING_FIELDS = [
  "issuer",
  "subject",
  "name",
  "givenName",
  "familyName",
  "nickname",
  "preferredUsername",
  "profileUrl",
  "pictureUrl",
  "websiteUrl",
  "email",
  "gender",
  "birthday",
  "timezone",
  "language",
  "phoneNumber",
  "address",
  "updatedAt",
];
const BOOL_FIELDS = ["emailVerified", "phoneNumberVerified"];

/**
 * The identity an admin acts as (Convex's `UserIdentityAttributes` from JSON): an object with
 * `tokenIdentifier`, or `issuer` and `subject` (then `tokenIdentifier` is `issuer|subject`); the standard
 * fields typed, every other field a custom claim. Null when it is not one.
 */
export function actingIdentity(json: unknown): Record<string, unknown> | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  for (const f of STRING_FIELDS) if (o[f] !== undefined && o[f] !== null && typeof o[f] !== "string") return null;
  for (const f of BOOL_FIELDS) if (o[f] !== undefined && o[f] !== null && typeof o[f] !== "boolean") return null;
  let tokenIdentifier = o.tokenIdentifier;
  if (tokenIdentifier !== undefined && typeof tokenIdentifier !== "string") return null;
  if (tokenIdentifier === undefined) {
    if (typeof o.issuer !== "string" || typeof o.subject !== "string") return null;
    tokenIdentifier = `${o.issuer}|${o.subject}`;
  }
  const out: Record<string, unknown> = { tokenIdentifier };
  for (const [k, v] of Object.entries(o)) if (k !== "tokenIdentifier" && v !== null && v !== undefined) out[k] = v;
  return out;
}

/** `<key>[:<base64 JSON identity>]` after `removeTypePrefix` (Convex's `extract_admin_key`). */
export function splitActingAs(key: string): { key: string; actingAs: Record<string, unknown> | null } {
  const stripped = removeTypePrefix(key);
  const colon = stripped.indexOf(":");
  if (colon === -1) return { key: stripped, actingAs: null };
  const b64 = stripped.slice(colon + 1);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new HeaderParseError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    throw new HeaderParseError();
  }
  const actingAs = actingIdentity(parsed);
  if (!actingAs) throw new HeaderParseError();
  return { key: stripped.slice(0, colon), actingAs };
}

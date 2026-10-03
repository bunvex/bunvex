// Pagination cursors (STUDY-17). Convex's cursor is a position — after an index key, or the end — plus a
// fingerprint of the query, sealed by the keybroker (crates/keybroker/src/broker.rs `encrypt_cursor`):
//
// - the `InstanceCursor` proto (crates/pb/protos/convex_cursor.proto): the instance name (1), the position
//   (`after` = an `IndexKey` with the key bytes in field 4, or `end` = Empty), the fingerprint (4);
// - sealed with AES-128-GCM-SIV under KBKDF(secret, "cursor"), deterministically (a zero nonce, not sent),
//   the version byte 7 as associated data;
// - hex of the version byte, the ciphertext and its tag.
//
// bunvex's are the same (DV-73 resolved): opaque, the same position gives the same cursor, and a cursor
// from another instance or query is refused.
import { createHash } from "node:crypto";
import { BunvexError } from "@bunvex/values";
import { aes128GcmSivOpen, aes128GcmSivSeal } from "./aead.ts";

export type CursorPosition = { after: Uint8Array } | "end";

/** What sealing a cursor needs: the key derived for "cursor", and the instance name it names. */
export type CursorCodec = { key: Uint8Array; instanceName: string };

/** Convex's CURSOR_VERSION. */
const CURSOR_VERSION = 7;
const ZERO_NONCE = new Uint8Array(12);
const AAD = Uint8Array.of(CURSOR_VERSION);

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** A query's fingerprint: what it reads (table, index, range) and in which order. */
export function queryFingerprint(parts: {
  tablet: number;
  index: number;
  lo: Uint8Array;
  hi: Uint8Array;
  desc: boolean;
}): Uint8Array {
  return new Uint8Array(
    createHash("sha256")
      .update(`${parts.tablet}:${parts.index}:${b64(parts.lo)}:${b64(parts.hi)}:${parts.desc ? "desc" : "asc"}`)
      .digest(),
  );
}

const utf8 = new TextEncoder();

function varint(n: number, out: number[]) {
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
}

/** A length-delimited field (wire type 2). */
function field(num: number, bytes: Uint8Array | number[], out: number[]) {
  varint((num << 3) | 2, out);
  varint(bytes.length, out);
  for (const b of bytes) out.push(b);
}

function encodeInstanceCursor(instanceName: string, pos: CursorPosition, fingerprint: Uint8Array): Uint8Array {
  const out: number[] = [];
  if (instanceName) field(1, utf8.encode(instanceName), out);
  if (pos === "end") field(3, [], out);
  else {
    const key: number[] = [];
    if (pos.after.length) field(4, pos.after, key);
    field(2, key, out);
  }
  if (fingerprint.length) field(4, fingerprint, out);
  return Uint8Array.from(out);
}

/** The length-delimited fields of a proto message, by number (the last of each wins, as in proto3). */
function fields(b: Uint8Array): Map<number, Uint8Array> | null {
  const out = new Map<number, Uint8Array>();
  let i = 0;
  const read = (): number | null => {
    let n = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (i >= b.length) return null;
      const x = b[i++]!;
      n += (x & 0x7f) * 2 ** shift;
      if (x < 0x80) return n;
    }
    return null;
  };
  while (i < b.length) {
    const tag = read();
    if (tag === null) return null;
    const wire = tag % 8;
    if (wire === 0) {
      if (read() === null) return null;
    } else if (wire === 2) {
      const len = read();
      if (len === null || i + len > b.length) return null;
      out.set(Math.floor(tag / 8), b.subarray(i, i + len));
      i += len;
    } else return null;
  }
  return out;
}

export function encodeCursor(codec: CursorCodec, pos: CursorPosition, fingerprint: Uint8Array): string {
  const proto = encodeInstanceCursor(codec.instanceName, pos, fingerprint);
  const sealed = aes128GcmSivSeal(codec.key, ZERO_NONCE, AAD, proto);
  const out = new Uint8Array(1 + sealed.length);
  out[0] = CURSOR_VERSION;
  out.set(sealed, 1);
  return Buffer.from(out).toString("hex");
}

const parseError = () => new Error("InvalidCursor: Failed to parse cursor");

/**
 * A cursor of another query (the data under a paginated query changed its shape): an app error with data, as
 * Convex's `invalid_cursor()` (crates/database/src/query/mod.rs), so a function may catch it and a client
 * recognizes it and restarts the pagination. Convex's key `isConvexSystemError` is `isBunvexSystemError` here
 * (STUDY-26 P1). A cursor that does not parse stays a plain error, as Convex's keybroker's.
 */
export const INVALID_CURSOR_DATA = { isBunvexSystemError: true, paginationError: "InvalidCursor" } as const;
function differentQueryError() {
  const e = new BunvexError<{ isBunvexSystemError: boolean; paginationError: string }>({ ...INVALID_CURSOR_DATA });
  e.message =
    "InvalidCursor: Tried to run a query starting from a cursor, but it looks like this cursor is from a different query.";
  return e;
}

export function decodeCursor(codec: CursorCodec, cursor: string, fingerprint: Uint8Array): CursorPosition {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(cursor)) throw parseError();
  const bytes = new Uint8Array(Buffer.from(cursor, "hex"));
  if (bytes[0] !== CURSOR_VERSION) throw parseError();
  const proto = aes128GcmSivOpen(codec.key, ZERO_NONCE, AAD, bytes.subarray(1));
  const f = proto && fields(proto);
  if (!f) throw parseError();
  const instance = new TextDecoder().decode(f.get(1) ?? new Uint8Array());
  if (instance !== codec.instanceName)
    throw new Error(`InvalidCursor: Key is invalid for instance ${JSON.stringify(instance)}`);
  const after = f.get(2);
  const end = f.get(3);
  if (after === undefined && end === undefined) throw new Error("InvalidCursor: Missing position field");
  if (!Buffer.from(f.get(4) ?? []).equals(Buffer.from(fingerprint))) throw differentQueryError();
  if (after === undefined) return "end";
  const key = fields(after);
  if (!key) throw parseError();
  return { after: new Uint8Array(key.get(4) ?? []) };
}

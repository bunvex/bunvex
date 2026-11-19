// Password hashing for `@bunvex/auth`'s `authPassword` component (AD-49, STUDY-201 C-2): argon2id as Convex Auth v2's
// `password-hash-wasm` (`argon2id-wasm` before 2.0.0) computes it (16 MiB, t = 3, p = 1, a 32-byte tag, its PHC
// string), on Bun's native `node:crypto` argon2, which runs on the thread pool instead of the deployment's one JS thread.
// The salt is the caller's: drawn in the mutation from its seeded stream, as v2 draws it, so the same salt gives v2's
// string byte for byte.
//
// A function reaches it by importing `@bunvex/server/password`, a module the runtime links (it is never bundled). It
// answers only where the running function's scope carries a hasher: a mutation of a component whose definition is
// named `authPassword` (`Functions.invoke`). Under the function sandbox the child forwards the call, and the host,
// in that mutation's scope, decides. The name identifies the component; it does not authenticate it: any pushed
// component may call itself that. What it guards is that the closed context stays closed to everyone else.
import { argon2, timingSafeEqual } from "node:crypto";
import { pausingUserTime, type Tx } from "@bunvex/core";
import { runningScope } from "./function-handles.ts";

/** The definition name of the one component whose mutations may hash passwords. */
export const PASSWORD_COMPONENT = "authPassword";

// `password-hash-wasm`'s parameters (Rust `argon2` 0.5's defaults: argon2id, version 0x13, a 32-byte output).
const MEMORY_KIB = 16384;
const PASSES = 3;
const PARALLELISM = 1;
const TAG_BYTES = 32;
/** argon2's shortest salt (RFC 9106 §3.1). */
const MIN_SALT_BYTES = 8;
// A stored string's costs, bounded (AD-49, owner 2026-11-02): v2's WASM runs in the function's isolate, whose memory is
// bounded, so an outsized `m` fails that function; here it would be allocated in the deployment's own process. v2 writes
// m=16384, t=3.
/** The most memory a stored hash may ask for, in KiB (64 MiB). */
export const MAX_MEMORY_KIB = 65536;
/** The most passes a stored hash may ask for. */
export const MAX_PASSES = 10;

type Algorithm = "argon2id" | "argon2i" | "argon2d";
const ALGORITHMS: readonly string[] = ["argon2id", "argon2i", "argon2d"];

/** What a hashing function's scope carries: the host's hasher, or the sandbox child's forwarder to it. */
export type PasswordHasher = {
  hash(password: string, salt: Uint8Array): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};

/** PHC's base64: the standard alphabet, unpadded. */
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/=+$/, "");

type Derivation = {
  algorithm: Algorithm;
  salt: Uint8Array;
  memory: number;
  passes: number;
  parallelism: number;
  data?: Uint8Array | undefined;
  tag: { length: number };
};

function derive(d: Derivation, password: string): Promise<Buffer> {
  const { memory, passes, parallelism } = d;
  const params = { message: password, nonce: d.salt, memory, passes, parallelism, tagLength: d.tag.length };
  return new Promise((resolve, reject) =>
    argon2(d.algorithm, d.data ? { ...params, associatedData: d.data } : params, (e, tag) =>
      e ? reject(e) : resolve(tag),
    ),
  );
}

/** The argon2id PHC string of `password` under `salt`, as `password-hash-wasm`'s `hashPassword` makes it. */
export async function argon2idPhc(password: string, salt: Uint8Array): Promise<string> {
  let tag: Buffer;
  try {
    const own = { algorithm: "argon2id", salt, memory: MEMORY_KIB, passes: PASSES, parallelism: PARALLELISM } as const;
    tag = await derive({ ...own, tag: { length: TAG_BYTES } }, password);
  } catch (e) {
    throw new Error(`Failed to hash password: ${(e as Error).message}`);
  }
  return `$argon2id$v=19$m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}$${b64(salt)}$${b64(tag)}`;
}

// A stored hash is read in two steps, as v2's `password-hash-wasm` reads it (Rust `password-hash` 0.5.0's PHC parser,
// then `argon2` 0.5.3's verifier; STUDY-208 §6): a string that is not a PHC string throws, with the parser's messages;
// a PHC string that argon2 cannot verify (another algorithm or version, an unknown parameter, a cost out of range, a
// salt under 8 bytes, no salt or no tag) does not match, as a wrong password does not.

/** A PHC string's fields, as the PHC grammar reads them (`$id[$v=version][$params][$salt[$hash]]`). */
type PhcString = { id: string; version?: number; params: [string, string][]; salt?: string; hash?: Buffer };

const IDENT = /^[a-z0-9-]{1,32}$/;
const firstNotIn = (text: string, allowed: RegExp) => [...text].find((c) => !allowed.test(c));
const VALUE_CHAR = /[A-Za-z0-9/+.-]/;

/** Why `text` is not a PHC value (at most 64 bytes of `[A-Za-z0-9/+.-]`), or nothing. */
function valueError(text: string): string | undefined {
  if (Buffer.byteLength(text) > 64) return "value to long";
  const bad = firstNotIn(text, VALUE_CHAR);
  return bad === undefined ? undefined : `contains invalid character: '${bad}'`;
}

/** `text` as a PHC decimal (digits, no leading zero, at most 2^32 - 1), or why not. */
function decimal(text: string): number | string {
  if (text === "") return "value malformed";
  const bad = firstNotIn(text, /[0-9]/);
  if (bad !== undefined) return `contains invalid character: '${bad}'`;
  if (text.length > 1 && text.startsWith("0")) return "value format is invalid";
  const n = Number(text);
  return n > 0xffffffff ? "value format is invalid" : n;
}

/** `text` as canonical unpadded standard base64 of at most `max` bytes, or why not. */
function base64(text: string, max: number): Buffer | string {
  const whole = Math.floor(text.length / 4);
  if (3 * whole + Math.floor((3 * (text.length - 4 * whole)) / 4) > max) return "invalid Base64 length";
  if (!/^[A-Za-z0-9+/]*$/.test(text) || text.length % 4 === 1) return "invalid Base64 encoding";
  const bytes = Buffer.from(text, "base64");
  return b64(bytes) === text ? bytes : "invalid Base64 encoding";
}

/** `text`'s PHC fields, or why it is not a PHC string. */
function parsePhcString(text: string): PhcString | string {
  const fields = text.split("$");
  if (text === "" || fields[0] !== "") return "password hash string missing field";
  let at = 1;
  const id = fields[at]!;
  if (!IDENT.test(id)) return "invalid parameter name";
  const phc: PhcString = { id, params: [] };
  let field = fields[++at];
  if (field?.startsWith("v=") && !field.includes(",")) {
    const version = valueError(field.slice(2)) ?? decimal(field.slice(2));
    if (typeof version === "string") return `invalid parameter value: ${version}`;
    phc.version = version;
    field = fields[++at];
  }
  if (field?.includes("=")) {
    if (Buffer.byteLength(field) > 127) return "maximum number of parameters reached";
    for (const pair of field.split(",")) {
      const [name, value, extra] = pair.split("=");
      if (!IDENT.test(name!)) return "invalid parameter name";
      const why =
        value === undefined
          ? "value malformed"
          : (valueError(value) ?? (extra === undefined ? undefined : "value malformed"));
      if (why) return `invalid parameter value: ${why}`;
      phc.params.push([name!, value!]);
    }
    field = fields[++at];
  }
  if (field !== undefined) {
    const length = Buffer.byteLength(field);
    const bad = firstNotIn(field, VALUE_CHAR);
    if (length < 4) return "salt invalid: value to short";
    if (length > 64) return "salt invalid: value to long";
    if (bad !== undefined) return `salt invalid: contains invalid character: '${bad}'`;
    phc.salt = field;
    field = fields[++at];
  }
  if (field !== undefined) {
    const hash = base64(field, 64);
    if (typeof hash === "string") return hash;
    if (hash.length < 10) return "output size too short, expected at least 10 bytes";
    phc.hash = hash;
    field = fields[++at];
  }
  return field === undefined ? phc : "password hash string contains trailing characters";
}

type Argon2Input = {
  algorithm: Algorithm;
  memory: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  data: Buffer | undefined;
  tag: Buffer;
};

/**
 * What argon2 computes to check `phc`, or nothing where it cannot: as `argon2` 0.5.3 verifies, the costs are the
 * string's own, a missing one is that crate's default (m=19456, t=2, p=1), `keyid` is read and unused, and `data` is
 * the associated data.
 */
function argon2Input(phc: PhcString): Argon2Input | undefined {
  if (!phc.salt || !phc.hash || !ALGORITHMS.includes(phc.id)) return undefined;
  // DV-585: Bun's argon2 computes only version 0x13, so a 0x10 hash (`v=16`), which v2's crate verifies, never matches.
  if (phc.version !== undefined && phc.version !== 0x13) return undefined;
  const costs = { m: 19456, t: 2, p: 1 };
  let data: Buffer | undefined;
  for (const [name, value] of phc.params) {
    if (name === "m" || name === "t" || name === "p") {
      const n = decimal(value);
      if (typeof n === "string") return undefined;
      costs[name] = n;
    } else if (name === "keyid" || name === "data") {
      const bytes = base64(value, name === "keyid" ? 8 : 32);
      if (typeof bytes === "string") return undefined;
      if (name === "data") data = bytes;
    } else return undefined;
  }
  const { m, t, p } = costs;
  if (m < 8 || m < 8 * p || t < 1 || p < 1 || p > 0xffffff) return undefined;
  const salt = base64(phc.salt, 64);
  if (typeof salt === "string" || salt.length < MIN_SALT_BYTES) return undefined;
  return { algorithm: phc.id as Algorithm, memory: m, passes: t, parallelism: p, salt, data, tag: phc.hash };
}

/** Whether `password` is the one `hash` (a PHC string) was made from, under the string's own parameters. */
export async function verifyPhc(password: string, hash: string): Promise<boolean> {
  // v2 wraps the crate's error, so its message reads "...stored hash: Error: <why>".
  const fail = (why: string) => new Error(`Failed to verify password against the stored hash: Error: ${why}`);
  const phc = parsePhcString(hash);
  if (typeof phc === "string") throw fail(phc);
  const input = argon2Input(phc);
  if (!input) return false;
  if (input.memory > MAX_MEMORY_KIB) throw fail(`memory cost over ${MAX_MEMORY_KIB} KiB`);
  if (input.passes > MAX_PASSES) throw fail(`time cost over ${MAX_PASSES}`);
  let tag: Buffer;
  try {
    tag = await derive(input, password);
  } catch (e) {
    throw fail((e as Error).message);
  }
  return timingSafeEqual(tag, input.tag);
}

/**
 * A mutation's hasher, on `db`: each hash is work in flight for its runner (not a function that can never resolve), and
 * its time, spent on the thread pool, is not the function's, as a store call's is not.
 */
export function passwordHasher(db: Tx): PasswordHasher {
  const off = <T>(work: () => Promise<T>): Promise<T> => {
    const p = pausingUserTime(work);
    db.track(p);
    return p;
  };
  return {
    hash: (password, salt) => off(() => argon2idPhc(password, salt)),
    verify: (password, hash) => off(() => verifyPhc(password, hash)),
  };
}

const unavailable = (name: string) =>
  new Error(`${name} can only be called from a mutation of the ${PASSWORD_COMPONENT} component`);

function hasher(name: string): PasswordHasher {
  const h = runningScope()?.password;
  if (!h) throw unavailable(name);
  return h;
}

/** `bytes` as a `Uint8Array` of this realm (a function's comes from its own context). */
function saltBytes(bytes: unknown): Uint8Array {
  if (!ArrayBuffer.isView(bytes) && Object.prototype.toString.call(bytes) !== "[object ArrayBuffer]")
    throw new TypeError("hashPassword: the salt must be bytes");
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes as ArrayBuffer);
  if (view.byteLength < MIN_SALT_BYTES)
    throw new TypeError(`hashPassword: the salt must be ${MIN_SALT_BYTES} bytes or more`);
  return Uint8Array.from(view);
}

// `password-hash-wasm`'s `hashPassword`, with the salt passed in (v2 draws it inside, from the mutation's stream).
/**
 * The argon2id hash of `password` (16 MiB, 3 passes, 1 lane, a 32-byte tag) under `salt`, as a PHC string. Only a
 * mutation of the `authPassword` component may call it.
 */
export function hashPassword(password: string, salt: Uint8Array): Promise<string> {
  try {
    if (typeof password !== "string") throw new TypeError("hashPassword: the password must be a string");
    return hasher("hashPassword").hash(password, saltBytes(salt));
  } catch (e) {
    return Promise.reject(e);
  }
}

// `password-hash-wasm`'s `verifyPassword`.
/**
 * Whether `password` matches `hash`, a PHC string of argon2id, argon2i or argon2d, under the string's own parameters. A
 * PHC string of another algorithm, or one argon2 cannot compute, does not match; a string that is not a PHC string
 * rejects. Only a mutation of the `authPassword` component may call it.
 */
export function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    if (typeof password !== "string") throw new TypeError("verifyPassword: the password must be a string");
    if (typeof hash !== "string") throw new TypeError("verifyPassword: the hash must be a string");
    return hasher("verifyPassword").verify(password, hash);
  } catch (e) {
    return Promise.reject(e);
  }
}

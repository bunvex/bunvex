// Password hashing for `@bunvex/auth`'s `authPassword` component (AD-49, STUDY-201 C-2): argon2id as Convex Auth v2's
// `argon2id-wasm` computes it (16 MiB, t = 3, p = 1, a 32-byte tag, its PHC string), on Bun's native `node:crypto`
// argon2, which runs on the thread pool instead of the deployment's one JS thread. The salt is the caller's: drawn in
// the mutation from its seeded stream, as v2 draws it, so the same salt gives v2's string byte for byte.
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

// `argon2id-wasm`'s parameters (Rust `argon2` 0.5's defaults: argon2id, version 0x13, a 32-byte output).
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
const unb64 = (text: string): Buffer | null => (/^[A-Za-z0-9+/]+$/.test(text) ? Buffer.from(text, "base64") : null);

function derive(
  algorithm: Algorithm,
  password: string,
  salt: Uint8Array,
  memory: number,
  passes: number,
  parallelism: number,
  tagLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2(algorithm, { message: password, nonce: salt, memory, passes, parallelism, tagLength }, (e, tag) =>
      e ? reject(e) : resolve(tag),
    ),
  );
}

/** The argon2id PHC string of `password` under `salt`, as `argon2id-wasm`'s `hashPassword` makes it. */
export async function argon2idPhc(password: string, salt: Uint8Array): Promise<string> {
  let tag: Buffer;
  try {
    tag = await derive("argon2id", password, salt, MEMORY_KIB, PASSES, PARALLELISM, TAG_BYTES);
  } catch (e) {
    throw new Error(`Failed to hash password: ${(e as Error).message}`);
  }
  return `$argon2id$v=19$m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}$${b64(salt)}$${b64(tag)}`;
}

type Phc = { algorithm: Algorithm; memory: number; passes: number; parallelism: number; salt: Buffer; tag: Buffer };

/**
 * A PHC string's algorithm, parameters, salt and tag, or why it cannot be read. As the Rust crate `argon2id-wasm`
 * verifies with, the parameters are the string's own (argon2i and argon2d too); a missing version is 0x13. Bun's
 * argon2 computes only version 0x13.
 */
function parsePhc(text: string): Phc | string {
  const parts = text.split("$");
  if (parts[0] !== "" || parts.length < 5 || parts.length > 6) return "not a PHC string";
  const algorithm = parts[1]!;
  if (!ALGORITHMS.includes(algorithm)) return `unsupported algorithm ${algorithm}`;
  let i = 2;
  if (parts[i]!.startsWith("v=")) {
    if (parts[i] !== "v=19") return `unsupported version ${parts[i]!.slice(2)}`;
    i++;
  }
  if (parts.length - i !== 3) return "not a PHC string";
  const params = new Map<string, number>();
  for (const pair of parts[i]!.split(",")) {
    const [name, value] = pair.split("=");
    if (!name || value === undefined || !/^\d{1,10}$/.test(value) || params.has(name))
      return `invalid parameter ${pair}`;
    params.set(name, Number(value));
  }
  const memory = params.get("m");
  const passes = params.get("t");
  const parallelism = params.get("p");
  if (memory === undefined || passes === undefined || parallelism === undefined || params.size !== 3)
    return "the parameters must be m, t and p";
  if (memory > MAX_MEMORY_KIB) return `memory cost over ${MAX_MEMORY_KIB} KiB`;
  if (passes > MAX_PASSES) return `time cost over ${MAX_PASSES}`;
  const salt = unb64(parts[i + 1]!);
  const tag = unb64(parts[i + 2]!);
  if (!salt || !tag) return "invalid base64";
  return { algorithm: algorithm as Algorithm, memory, passes, parallelism, salt, tag };
}

/** Whether `password` is the one `hash` (a PHC string) was made from, under the string's own parameters. */
export async function verifyPhc(password: string, hash: string): Promise<boolean> {
  const phc = parsePhc(hash);
  if (typeof phc === "string") throw new Error(`Failed to verify password against the stored hash: ${phc}`);
  let tag: Buffer;
  try {
    tag = await derive(phc.algorithm, password, phc.salt, phc.memory, phc.passes, phc.parallelism, phc.tag.length);
  } catch (e) {
    throw new Error(`Failed to verify password against the stored hash: ${(e as Error).message}`);
  }
  return timingSafeEqual(tag, phc.tag);
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

// `argon2id-wasm`'s `hashPassword`, with the salt passed in (v2 draws it inside, from the mutation's stream).
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

// `argon2id-wasm`'s `verifyPassword`.
/**
 * Whether `password` matches `hash`, a PHC string (argon2id, argon2i or argon2d, under its own parameters). Only a
 * mutation of the `authPassword` component may call it.
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

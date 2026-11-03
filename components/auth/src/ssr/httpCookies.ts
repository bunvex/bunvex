// The session's cookies on a WHATWG request and response (STUDY-202 §1.2), v2's `ssr/httpCookies.ts` without the
// `cookie` package: the `Cookie` header parsed and `Set-Cookie` lines written as `cookie@1.1.1`'s `parse` and
// `serialize` do, byte for byte (`test/ssr-cookies.test.ts` checks them against it). Web APIs only: this runs in the
// app's server.
import type { CookieOptions, CookieStore } from "./cookies.ts";

// RFC 6265's characters: a name is a token (no separators), a value any visible ASCII but `"`, `,`, `;` and `\` once
// URL-encoded, which leaves `;` the only one encoding can produce; a path anything but control characters and `;`.
const NAME = /^[!-:<>-~]+$/;
const VALUE = /^[!-:<-~]*$/;
const DOMAIN = /^([.]?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const PATH = /^[ -:=-~]*$/;

const SAME_SITE = { strict: "Strict", lax: "Lax", none: "None" } as const;

// A Date from any realm.
const isDate = (value: unknown): value is Date => Object.prototype.toString.call(value) === "[object Date]";

/**
 * A `Set-Cookie` header's value. `path` defaults to `/` and `maxAge` is rounded down; the value is URL-encoded. A name,
 * value, domain or path outside what a cookie may hold throws a `TypeError`.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!NAME.test(name)) throw new TypeError(`argument name is invalid: ${name}`);
  const encoded = value ? encodeURIComponent(value) : "";
  if (!VALUE.test(encoded)) throw new TypeError(`argument val is invalid: ${value}`);
  let line = `${name}=${encoded}`;
  if (options.maxAge !== undefined) {
    const maxAge = Math.floor(options.maxAge);
    if (!Number.isInteger(maxAge)) throw new TypeError(`option maxAge is invalid: ${maxAge}`);
    line += `; Max-Age=${maxAge}`;
  }
  if (options.domain) {
    if (!DOMAIN.test(options.domain)) throw new TypeError(`option domain is invalid: ${options.domain}`);
    line += `; Domain=${options.domain}`;
  }
  const path = options.path ?? "/";
  if (path) {
    if (!PATH.test(path)) throw new TypeError(`option path is invalid: ${path}`);
    line += `; Path=${path}`;
  }
  if (options.expires) {
    if (!isDate(options.expires) || !Number.isFinite(options.expires.valueOf()))
      throw new TypeError(`option expires is invalid: ${options.expires}`);
    line += `; Expires=${options.expires.toUTCString()}`;
  }
  if (options.httpOnly) line += "; HttpOnly";
  if (options.secure) line += "; Secure";
  if (options.sameSite) {
    // `true` is Strict, as `cookie` takes it from JavaScript.
    const key = (options.sameSite as unknown) === true ? "strict" : String(options.sameSite).toLowerCase();
    const sameSite = Object.hasOwn(SAME_SITE, key) ? SAME_SITE[key as keyof typeof SAME_SITE] : undefined;
    if (sameSite === undefined) throw new TypeError(`option sameSite is invalid: ${options.sameSite}`);
    line += `; SameSite=${sameSite}`;
  }
  return line;
}

// Spaces and tabs around a name or a value are not part of it.
const trim = (text: string) => text.replace(/^[ \t]+|[ \t]+$/g, "");

// A value with `%` escapes decoded, or as it is when they do not decode (another app's cookie must not break this one).
function decode(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * A `Cookie` header's pairs by name. A pair without `=` is skipped; the first of two pairs with one name wins; quotes
 * are kept.
 */
export function parseCookieHeader(header: string): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  // The shortest pair is a name and its `=`.
  if (header.length < 2) return cookies;
  for (let start = 0; start < header.length; ) {
    let end = header.indexOf(";", start);
    if (end === -1) end = header.length;
    const eq = header.indexOf("=", start);
    if (eq === -1) break;
    if (eq > end) {
      // This pair has no `=`: the one found belongs to a later pair.
      start = header.lastIndexOf(";", eq - 1) + 1;
      continue;
    }
    const name = trim(header.slice(start, eq));
    if (cookies[name] === undefined) cookies[name] = decode(trim(header.slice(eq + 1, end)));
    start = end + 1;
  }
  return cookies;
}

/** A request's cookies, and the `Set-Cookie` lines its response must carry. */
export interface HttpCookies extends CookieStore {
  /** Append a `Set-Cookie` line per write and deletion, in order. */
  applyTo: (headers: Headers) => void;
}

/**
 * The cookies of a WHATWG request: read from its `Cookie` header, with writes and deletions read back within the
 * request, and kept for the response.
 */
export function httpCookies(request: Request): HttpCookies {
  const jar = parseCookieHeader(request.headers.get("cookie") ?? "");
  const written = new Map<string, string | null>();
  const lines: string[] = [];
  return {
    get(name) {
      if (written.has(name)) return written.get(name) ?? undefined;
      return jar[name];
    },
    set(name, value, options) {
      written.set(name, value);
      lines.push(serializeCookie(name, value, options));
    },
    delete(name, options) {
      written.set(name, null);
      lines.push(
        serializeCookie(name, "", {
          path: options?.path ?? "/",
          domain: options?.domain,
          maxAge: 0,
          expires: new Date(0),
        }),
      );
    },
    applyTo(headers) {
      for (const line of lines) headers.append("set-cookie", line);
    },
  };
}

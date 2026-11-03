// The session's cookies and the access token on the app's server (STUDY-202 §1.2, §1.3): upstream's `ssr/cookies.test.ts`
// and `ssr/httpCookies.test.ts` ported, then bunvex's own parsing, serializing and token decoding against the libraries
// v2 uses for them, `cookie@1.1.1` and `jose`'s `decodeJwt`, over a generated corpus: the same answer, or the same error.
import { describe, expect, test } from "bun:test";
import * as cookie from "cookie";
import { decodeJwt } from "jose";
import type { TokenBundle } from "../src/lib/types.ts";
import {
  AUTH_JWT_COOKIE,
  AUTH_REFRESH_COOKIE,
  type AuthCookieOptions,
  type CookieDeleteOptions,
  type CookieOptions,
  type CookieStore,
  clearAuthCookies,
  writeAuthCookies,
} from "../src/ssr/cookies.ts";
import { httpCookies, parseCookieHeader, serializeCookie } from "../src/ssr/httpCookies.ts";
import { decodeAccessToken, isTokenExpiring } from "../src/ssr/jwt.ts";

const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 2_000_000,
  userId: "user-1",
};

class FakeCookies implements CookieStore {
  writes = new Map<string, CookieOptions | undefined>();
  deletions = new Map<string, CookieDeleteOptions | undefined>();
  get() {
    return undefined;
  }
  set(name: string, _value: string, options?: CookieOptions) {
    this.writes.set(name, options);
  }
  delete(name: string, options?: CookieDeleteOptions) {
    this.deletions.set(name, options);
  }
}

describe("writeAuthCookies", () => {
  test("applies the invariant attributes and the caller's options", async () => {
    const cookies = new FakeCookies();
    await writeAuthCookies(cookies, bundle, { secure: true, path: "/app", domain: "example.com" });
    for (const name of [AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE])
      expect(cookies.writes.get(name)).toEqual({
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        path: "/app",
        domain: "example.com",
        expires: new Date(bundle.refreshTokenExpiresAt),
      });
  });

  test("a wider options object cannot override the invariants", async () => {
    const cookies = new FakeCookies();
    // What an untyped caller could pass.
    const hostile = {
      secure: false,
      httpOnly: false,
      sameSite: "none",
      maxAge: 5,
      expires: new Date(0),
    } as AuthCookieOptions;
    await writeAuthCookies(cookies, bundle, hostile);
    for (const name of [AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE]) {
      const written = cookies.writes.get(name)!;
      expect(written.httpOnly).toBe(true);
      expect(written.sameSite).toBe("lax");
      expect(written.maxAge).toBeUndefined();
      expect(written.expires).toEqual(new Date(bundle.refreshTokenExpiresAt));
    }
  });

  test("the cookies are named as the browser's storage keys, the access token's first", async () => {
    const cookies = new FakeCookies();
    await writeAuthCookies(cookies, bundle, { secure: true });
    expect([...cookies.writes.keys()]).toEqual(["__bunvexAuthJWT", "__bunvexAuthRefreshToken"]);
  });
});

describe("clearAuthCookies", () => {
  test("deletes both cookies with the configured path and domain", async () => {
    const cookies = new FakeCookies();
    await clearAuthCookies(cookies, { secure: true, path: "/app", domain: "example.com" });
    for (const name of [AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE])
      expect(cookies.deletions.get(name)).toEqual({ path: "/app", domain: "example.com" });
  });

  test("path defaults to / to match the write-side default", async () => {
    const cookies = new FakeCookies();
    await clearAuthCookies(cookies, { secure: true });
    expect(cookies.deletions.get(AUTH_JWT_COOKIE)).toEqual({ path: "/", domain: undefined });
  });
});

describe("serializeCookie", () => {
  test("emits the attributes it is given", () => {
    const line = serializeCookie("tok", "abc", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60,
      domain: "example.com",
    });
    for (const part of ["tok=abc", "Path=/", "Max-Age=60", "Domain=example.com", "HttpOnly", "Secure", "SameSite=Lax"])
      expect(line).toContain(part);
  });

  test("omits attributes that were not set", () => {
    expect(serializeCookie("tok", "abc")).toBe("tok=abc; Path=/");
  });

  test("url-encodes the value", () => {
    expect(serializeCookie("t", "a b/c")).toContain("t=a%20b%2Fc");
  });

  test("emits SameSite=None for cross-site cookies", () => {
    expect(serializeCookie("t", "abc", { sameSite: "none", secure: true })).toContain("SameSite=None");
  });

  test("floors a non-integer maxAge rather than throwing", () => {
    expect(serializeCookie("t", "abc", { maxAge: 60.7 })).toContain("Max-Age=60");
  });
});

describe("httpCookies", () => {
  const requestWith = (header?: string) =>
    new Request("https://app.test/", { headers: header ? { cookie: header } : {} });

  test("reads values from the request Cookie header", () => {
    const cookies = httpCookies(requestWith("a=1; b=hello%20world"));
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("b")).toBe("hello world");
    expect(cookies.get("missing")).toBeUndefined();
  });

  test("a foreign cookie with malformed percent-encoding does not throw", () => {
    // Another app's cookie must not fail the request: its raw value is kept, and ours still read.
    const cookies = httpCookies(requestWith("other=100%; a=1"));
    expect(cookies.get("other")).toBe("100%");
    expect(cookies.get("a")).toBe("1");
  });

  test("writes reflect back to reads within the request", () => {
    const cookies = httpCookies(requestWith("a=1"));
    cookies.set("a", "2");
    cookies.set("c", "new");
    expect(cookies.get("a")).toBe("2");
    expect(cookies.get("c")).toBe("new");
  });

  test("a deleted cookie reads as undefined", () => {
    const cookies = httpCookies(requestWith("a=1"));
    cookies.delete("a");
    expect(cookies.get("a")).toBeUndefined();
  });

  test("delete emits the path and domain it is given, matching the write", () => {
    const cookies = httpCookies(requestWith("a=1"));
    cookies.delete("a", { path: "/app", domain: "example.com" });
    const headers = new Headers();
    cookies.applyTo(headers);
    const [line] = headers.getSetCookie();
    for (const part of ["a=", "Path=/app", "Domain=example.com", "Max-Age=0"]) expect(line).toContain(part);
  });

  test("applyTo appends a Set-Cookie per write and delete", () => {
    const cookies = httpCookies(requestWith());
    cookies.set("tok", "abc", { httpOnly: true, path: "/" });
    cookies.delete("stale");
    const headers = new Headers();
    cookies.applyTo(headers);
    const lines = headers.getSetCookie();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("tok=abc");
    expect(lines[0]).toContain("HttpOnly");
    // A deletion: in the past, and Max-Age=0.
    expect(lines[1]).toBe("stale=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });
});

// A seeded generator, so a failure reproduces.
function random(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  return { next, int, pick };
}

// biome-ignore format: a table
// The characters that matter to a cookie: separators, spaces, escapes (valid and not), quotes, controls, non-ASCII.
const PIECES = [
  "a", "b", "Z", "0", "9", "_", "-", ".", "~", "!", "$", "&", "'", "(", ")", "*", "+", "/", ":", "<", ">", "?", "@",
  "[", "]", "^", "`", "{", "|", "}", " ", "\t", ";", "=", ",", '"', "\\", "%", "%20", "%3B", "%2", "%zz", "%E2%82%AC",
  "%C3", "é", "€", "😀", "\u0000", "\u007f", "\n", "__bunvexAuthJWT", "__proto__", "constructor",
] as const;

const asResult = (run: () => unknown) => {
  try {
    return { value: run() };
  } catch (error) {
    return { error: `${(error as Error).name}: ${(error as Error).message}` };
  }
};

describe("against cookie@1.1.1", () => {
  test("parsing a Cookie header", () => {
    const r = random(202);
    for (let i = 0; i < 20_000; i++) {
      const header = Array.from({ length: r.int(12) }, () => r.pick(PIECES)).join("");
      expect({ header, cookies: { ...parseCookieHeader(header) } as Record<string, string | undefined> }).toEqual({
        header,
        cookies: { ...cookie.parse(header) },
      });
    }
  });

  test("serializing a Set-Cookie line, or refusing it with the same TypeError", () => {
    const r = random(6265);
    const word = () => Array.from({ length: r.int(6) }, () => r.pick(PIECES)).join("");
    const maybe = <T>(value: () => T) => (r.int(3) === 0 ? value() : undefined);
    for (let i = 0; i < 20_000; i++) {
      const name = r.int(4) === 0 ? word() : r.pick(["tok", AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE, "a"]);
      const value = r.int(3) === 0 ? word() : r.pick(["", "abc", "eyJ.a-b_c.d", "100%"]);
      const options: CookieOptions = {
        path: maybe(() => r.pick(["/", "/app", "", word()])),
        domain: maybe(() => r.pick(["example.com", ".example.com", "localhost", "", word()])),
        maxAge: maybe(() => r.pick([0, 60, 60.7, -1, Number.NaN, Number.POSITIVE_INFINITY])),
        expires: maybe(() => r.pick([new Date(0), new Date(2_000_000_000_000), new Date(Number.NaN)])),
        httpOnly: maybe(() => r.int(2) === 0),
        secure: maybe(() => r.int(2) === 0),
        sameSite: maybe(() => r.pick(["lax", "strict", "none", "Lax", "NONE", "bogus"])) as CookieOptions["sameSite"],
      };
      // v2's `serializeCookie`: `cookie.serialize` with the path defaulted and maxAge rounded down.
      const theirs = asResult(() =>
        cookie.serialize(name, value, {
          path: options.path ?? "/",
          maxAge: options.maxAge === undefined ? undefined : Math.floor(options.maxAge),
          expires: options.expires,
          domain: options.domain,
          httpOnly: options.httpOnly,
          secure: options.secure,
          sameSite: options.sameSite,
        }),
      );
      expect({ name, value, options, line: asResult(() => serializeCookie(name, value, options)) }).toEqual({
        name,
        value,
        options,
        line: theirs,
      });
    }
  });
});

describe("decoding an access token, against jose's decodeJwt", () => {
  const b64 = (text: string) => Buffer.from(text).toString("base64url");
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));

  test("well-formed and malformed tokens: the same claims, or none", () => {
    const payloads = [
      { exp: 1_900_000_000, sub: "session|user" },
      { exp: "1900000000", sub: 5 },
      { sub: "only" },
      {},
      [],
      [1, 2],
      "a string",
      42,
      null,
      { exp: 1.5, sub: "" },
    ];
    const tokens = [
      ...payloads.map((p) => `${header}.${b64(JSON.stringify(p))}.sig`),
      `${header}.${b64("not json")}.sig`,
      `${header}..sig`,
      `${header}.${b64("{}")}`,
      `${header}.${b64("{}")}.sig.extra`,
      `${header}.${b64("{}")}.a.b.c`,
      "",
      "garbage",
      `${header}.!!!.sig`,
      `${header}.${b64('{"exp":1}')}=.sig`,
      `${header}.${b64('{"sub":"x"}').slice(0, -1)}.sig`,
    ];
    const viaJose = (token: string) => {
      try {
        const claims = decodeJwt(token);
        return {
          exp: typeof claims.exp === "number" ? claims.exp : null,
          sub: typeof claims.sub === "string" ? claims.sub : null,
        };
      } catch {
        return { exp: null, sub: null };
      }
    };
    for (const token of tokens)
      expect({ token, ours: decodeAccessToken(token) }).toEqual({ token, ours: viaJose(token) });
  });

  test("isTokenExpiring: within the skew, past it, and no expiry", () => {
    const token = (exp?: number) => `${header}.${b64(JSON.stringify(exp === undefined ? {} : { exp }))}.sig`;
    const now = 1_000_000_000_000;
    expect(isTokenExpiring(token(1_000_000_011), 10, now)).toBe(false);
    expect(isTokenExpiring(token(1_000_000_010), 10, now)).toBe(true);
    expect(isTokenExpiring(token(1_000_000_001), 0, now)).toBe(false);
    expect(isTokenExpiring(token(1_000_000_000), 0, now)).toBe(true);
    expect(isTokenExpiring(token(), 0, now)).toBe(true);
    expect(isTokenExpiring("not a token", 0, now)).toBe(true);
  });
});

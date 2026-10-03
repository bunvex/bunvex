// The client version check (STUDY-67 H12, DV-315), as Convex's: its `ExtractClientVersion` and
// `client_version_state_middleware` (crates/common/src/http/mod.rs), `ClientVersion` and its thresholds
// (crates/common/src/version.rs, crates/common/deprecation.json). Every request to the API and the site:
// - the client header (`Bunvex-Client: <client>-<semver>`), else the version in the sync URL
//   (`/api/<semver>/sync`, an npm client's), else an unknown client, which is never refused;
// - a header that does not parse is 400 `InvalidClientVersion`; so is a sync URL version that is not semver;
// - a client at or below its type's `unsupported` threshold (an npm, CLI or actions client at 0.19.1 or older,
//   or with a version that is not semver) is 400 `ClientVersionUnsupported` with the deprecation headers;
// - at or below `upgradeRequired`, the request runs and its answer carries the deprecation headers.
// Convex's headers are `x-convex-deprecation-*`; bunvex's are `x-bunvex-deprecation-*` (rule 5, DV-315).

/** The header bunvex's clients send their version in (Convex's `Convex-Client`). */
export const CLIENT_HEADER = "bunvex-client";
export const DEPRECATION_STATE_HEADER = "x-bunvex-deprecation-state";
export const DEPRECATION_MESSAGE_HEADER = "x-bunvex-deprecation-message";

/** A semver version (the `semver` crate's `Version`), or why the text is not one, in that crate's words. */
type Semver = { major: bigint; minor: bigint; patch: bigint; pre: string; build: string };

const POSITION = ["major version number", "minor version number", "patch version number"] as const;
const U64_MAX = 2n ** 64n - 1n;

/** A character as Rust's `{:?}` prints it (the `semver` crate quotes the character it stopped at). */
function quoted(c: string): string {
  const escapes: Record<string, string> = {
    "\0": "\\0",
    "\t": "\\t",
    "\n": "\\n",
    "\r": "\\r",
    "'": "\\'",
    "\\": "\\\\",
  };
  if (escapes[c] !== undefined) return `'${escapes[c]}'`;
  const code = c.codePointAt(0)!;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return `'\\u{${code.toString(16)}}'`;
  return `'${c}'`;
}

/** The pre-release or build part (`identifier` in the `semver` crate): dot-separated `[0-9A-Za-z-]+`. */
function identifier(text: string, pre: boolean): { value: string; rest: string } | string {
  const where = pre ? "pre-release identifier" : "build metadata";
  let i = 0;
  let segment = 0;
  let nonDigit = false;
  for (;;) {
    const c = text[i];
    if (c !== undefined && /[A-Za-z-]/.test(c)) {
      segment++;
      nonDigit = true;
      i++;
    } else if (c !== undefined && c >= "0" && c <= "9") {
      segment++;
      i++;
    } else {
      if (segment === 0) {
        if (i === 0 && c !== ".") return { value: "", rest: text };
        return `empty identifier segment in ${where}`;
      }
      if (pre && segment > 1 && !nonDigit && text[i - segment] === "0") return `invalid leading zero in ${where}`;
      if (c !== ".") return { value: text.slice(0, i), rest: text.slice(i) };
      i++;
      segment = 0;
      nonDigit = false;
    }
  }
}

/** Parses a semver version; a string is the `semver` crate's message for why it does not parse. */
export function parseSemver(text: string): Semver | string {
  if (text === "") return "empty string, expected a semver version";
  const parts: bigint[] = [];
  let rest = text;
  for (let p = 0; p < 3; p++) {
    let n = 0;
    let value = 0n;
    while (n < rest.length && rest[n]! >= "0" && rest[n]! <= "9") {
      if (value === 0n && n > 0) return `invalid leading zero in ${POSITION[p]}`;
      value = value * 10n + BigInt(rest.charCodeAt(n) - 48);
      if (value > U64_MAX) return `value of ${POSITION[p]} exceeds u64::MAX`;
      n++;
    }
    if (n === 0) {
      const c = [...rest][0];
      return c === undefined
        ? `unexpected end of input while parsing ${POSITION[p]}`
        : `unexpected character ${quoted(c)} while parsing ${POSITION[p]}`;
    }
    parts.push(value);
    rest = rest.slice(n);
    if (p < 2) {
      if (rest[0] !== ".") {
        const c = [...rest][0];
        return c === undefined
          ? `unexpected end of input while parsing ${POSITION[p]}`
          : `unexpected character ${quoted(c)} after ${POSITION[p]}`;
      }
      rest = rest.slice(1);
    }
  }
  let where: string = POSITION[2];
  let pre = "";
  let build = "";
  if (rest.startsWith("-")) {
    where = "pre-release identifier";
    const r = identifier(rest.slice(1), true);
    if (typeof r === "string") return r;
    if (r.value === "") return `empty identifier segment in ${where}`;
    pre = r.value;
    rest = r.rest;
  }
  if (rest.startsWith("+")) {
    where = "build metadata";
    const r = identifier(rest.slice(1), false);
    if (typeof r === "string") return r;
    if (r.value === "") return `empty identifier segment in ${where}`;
    build = r.value;
    rest = r.rest;
  }
  const c = [...rest][0];
  if (c !== undefined) return `unexpected character ${quoted(c)} after ${where}`;
  return { major: parts[0]!, minor: parts[1]!, patch: parts[2]!, pre, build };
}

/**
 * Whether `v` is at or below a release threshold (`version <= threshold` in the `semver` crate's order: a
 * pre-release sorts before its release, build metadata after none).
 */
function atOrBelow(v: Semver, t: readonly [number, number, number]): boolean {
  const own = [v.major, v.minor, v.patch];
  for (let i = 0; i < 3; i++) {
    const a = own[i]!;
    const b = BigInt(t[i]!);
    if (a !== b) return a < b;
  }
  if (v.pre !== "") return true;
  return v.build === "";
}

type Thresholds = {
  upgradeRequired: readonly [number, number, number];
  unsupported: readonly [number, number, number];
};
// Convex's deprecation.json.
const NPM: Thresholds = { upgradeRequired: [0, 19, 1], unsupported: [0, 19, 1] };
const PYTHON: Thresholds = { upgradeRequired: [0, 2, 0], unsupported: [0, 0, 2] };
const RUST: Thresholds = { upgradeRequired: [0, 0, 1], unsupported: [0, 0, 1] };

/**
 * The client types that have thresholds, by the name a header gives (lower case), with the name Convex
 * prints and how to upgrade. Every other name (Convex's `CreateConvex`, `Dashboard`, `Swift`, … and
 * unrecognised ones) has none, so it is never refused. Convex also reads `python-convex` as python; rule 5
 * keeps that name out of bunvex (a header naming it is an unknown client).
 */
const TYPES: Record<string, { name: string; thresholds: Thresholds; upgrade: string }> = {
  npm: { name: "npm", thresholds: NPM, upgrade: "Update your npm package with `npm update`." },
  "npm-cli": { name: "npm-cli", thresholds: NPM, upgrade: "Update your npm package with `npm update`." },
  actions: { name: "actions", thresholds: NPM, upgrade: "Update your npm package with `npm update`." },
  python: {
    name: "python",
    thresholds: PYTHON,
    upgrade: "Update your python package with `pip install --upgrade`.",
  },
  rust: {
    name: "rust",
    thresholds: RUST,
    upgrade: "Update your rust crate with `cargo update` or by updating `Cargo.toml`.",
  },
};

/** What the check decides for a request: nothing to do (null), a refusal, or headers for the answer. */
export type ClientVersionVerdict =
  | null
  | { status: 400; code: "InvalidClientVersion" | "ClientVersionUnsupported"; message: string; headers: Headers }
  | { status: 200; headers: Headers };

const deprecation = (state: string, message: string) =>
  new Headers({ [DEPRECATION_STATE_HEADER]: state, [DEPRECATION_MESSAGE_HEADER]: message });

/** The state of a client, as Convex's `ClientVersion::current_state`. */
function stateOf(client: string, version: Semver | string, display: string): ClientVersionVerdict {
  const type = TYPES[client];
  if (type === undefined) return null;
  const below = (t: readonly [number, number, number]) => typeof version === "string" || atOrBelow(version, t);
  if (below(type.thresholds.unsupported)) {
    const message = `The ${type.name} package at version ${display} is no longer supported. ${type.upgrade}`;
    return { status: 400, code: "ClientVersionUnsupported", message, headers: deprecation("Unsupported", message) };
  }
  if (below(type.thresholds.upgradeRequired)) {
    const message =
      `The ${type.name} package at ${display} is deprecated and will no longer be supported soon. When this ` +
      "version is no longer supported, requests to the deployment will fail, so it is best to upgrade and " +
      `redeploy your application as soon as possible. ${type.upgrade}`;
    return { status: 200, headers: deprecation("UpgradeRequired", message) };
  }
  return null;
}

/** A header's verdict (Convex's `ClientVersion::from_str`: the longest semver from the right). */
function headerVerdict(header: string): ClientVersionVerdict {
  const parts = header.split("-");
  if (parts.length < 2) {
    const message =
      `Failed to parse client version string: '${header}'. Expected format is {client_name}-{semver}, ` +
      "e.g. my-esolang-client-0.0.1";
    return { status: 400, code: "InvalidClientVersion", message, headers: new Headers() };
  }
  for (let n = 1; n < parts.length; n++) {
    const text = parts.slice(n).join("-");
    const version = parseSemver(text);
    if (typeof version !== "string")
      return stateOf(parts.slice(0, n).join("-").toLowerCase(), version, display(version));
  }
  const rest = parts.slice(1).join("-");
  return stateOf(parts[0]!.toLowerCase(), rest, rest);
}

const display = (v: Semver) =>
  `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ""}${v.build ? `+${v.build}` : ""}`;

/**
 * A path segment percent-decoded as Convex's router does: `%XX` with two hex digits becomes that byte, any
 * other `%` stays as it is; bytes that are not UTF-8 are null (the extractor fails).
 */
function percentDecoded(segment: string): string | null {
  if (!segment.includes("%")) return segment;
  const bytes: number[] = [];
  for (let i = 0; i < segment.length; i++) {
    const hex = segment.slice(i + 1, i + 3);
    if (segment[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else bytes.push(...new TextEncoder().encode(segment[i]!));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/** The sync URL's version (Convex's `ClientVersion::from_path_param`: an npm client), when no header. */
function pathVerdict(segment: string): ClientVersionVerdict {
  const text = percentDecoded(segment);
  if (text === null) return null; // Convex's path extractor fails, and the client is unknown
  const version = parseSemver(text);
  if (typeof version === "string")
    return {
      status: 400,
      code: "InvalidClientVersion",
      message: `Failed to parse client version: ${version}`,
      headers: new Headers(),
    };
  return stateOf("npm", version, display(version));
}

// A header Convex reads at all: `HeaderValue::to_str` takes visible ASCII, spaces and tabs only; any other
// byte and the header counts as absent.
const VISIBLE = /^[\t\x20-\x7e]*$/;
const SYNC = /^\/api\/([^/]*)\/sync$/;

// Clients send a handful of distinct headers: their verdicts are kept (bounded, so arbitrary headers cannot
// grow it without limit).
const cache = new Map<string, ClientVersionVerdict>();
const CACHE_MAX = 1024;

function remember(key: string, compute: () => ClientVersionVerdict): ClientVersionVerdict {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const v = compute();
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, v);
  return v;
}

/** The verdict for a request: its client header, else (for the sync socket) the version in its URL. */
export function clientVersionVerdict(header: string | null, pathname: string): ClientVersionVerdict {
  if (header !== null && VISIBLE.test(header)) return remember(`h${header}`, () => headerVerdict(header));
  const m = SYNC.exec(pathname);
  if (m === null) return null;
  const segment = m[1]!;
  return remember(`p${segment}`, () => pathVerdict(segment));
}

/** A request URL's path, without parsing the whole URL (this runs on every request). */
function pathOf(url: string): string {
  const start = url.indexOf("/", url.indexOf("//") + 2);
  if (start < 0) return "/";
  const end = url.search(/[?#]/);
  return url.slice(start, end < 0 ? undefined : end);
}

/** The verdict for a request (see `clientVersionVerdict`). */
export const requestVerdict = (req: Request): ClientVersionVerdict =>
  clientVersionVerdict(req.headers.get(CLIENT_HEADER), pathOf(req.url));

function withHeaders(res: Response, headers: Headers): Response {
  try {
    headers.forEach((v, k) => {
      res.headers.set(k, v);
    });
    return res;
  } catch {
    // Immutable headers (a response from `fetch`): a copy.
    const h = new Headers(res.headers);
    headers.forEach((v, k) => {
      h.set(k, v);
    });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
}

/**
 * A server's `fetch` behind the check, outside every other layer (Convex's middleware wraps the router, so
 * its 400s carry no CORS headers). An upgraded socket's deprecation headers are the upgrade's own (see
 * `requestVerdict`).
 */
export function clientVersionCheck<S, R extends Response | undefined>(
  fetch: (req: Request, srv: S) => R | Promise<R>,
): (req: Request, srv: S) => Promise<R> {
  return async (req, srv) => {
    const verdict = requestVerdict(req);
    if (verdict === null) return fetch(req, srv);
    if (verdict.status === 400) {
      const headers = new Headers(verdict.headers);
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify({ code: verdict.code, message: verdict.message }), {
        status: 400,
        headers,
      }) as R;
    }
    const res = await fetch(req, srv);
    return (res === undefined ? res : withHeaders(res, verdict.headers)) as R;
  };
}

/** Bun server options whose `fetch` is behind the check (`clientVersionCheck`). */
export function withClientVersionCheck<D>(options: Bun.Serve.Options<D, never>): Bun.Serve.Options<D, never> {
  const o = options as Bun.Serve.Options<D, never> & {
    fetch: (req: Request, srv: Bun.Server<D>) => Response | undefined | Promise<Response | undefined>;
  };
  return { ...o, fetch: clientVersionCheck(o.fetch.bind(o)) } as Bun.Serve.Options<D, never>;
}

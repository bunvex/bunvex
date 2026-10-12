// An action's `fetch` (STUDY-80, STUDY-142): what it may reach, and how it fails, as Convex's runtime.
//
// - Convex's isolate builds every request with its own `Request`, which accepts only `http:` and `https:`
//   (`udf-runtime/src/23_request.ts`, `validateURL`), and reads only the web's `RequestInit` fields. Bun's
//   `fetch` also reads local files (`file:`), S3 objects with the process's credentials (`s3:`), and takes
//   `unix` (a Unix socket), `proxy`, `tls`, `timeout` and others. An action gets none of them: another scheme is
//   Convex's `TypeError`, and those options are dropped, as Convex ignores them.
// - Convex follows redirects in JS, one request per hop (`udf-runtime/src/26_fetch.ts`): at most 20, its own
//   errors, its rules for the method, the body and `Authorization`. bunvex follows them the same way, each
//   hop a `redirect: "manual"` request (so each goes through the proxy and its 407 names that hop).
// - A failed request is Convex's `TypeError` (`fetchFailure`): reqwest's message for the cause, with the URL's
//   query string, fragment and credentials dropped, or `fetch to <url> failed: <cause>` when the cause does
//   not name the URL (a body that fails to read). An abort is Convex's `AbortError`.
// - Requests carry Convex's default `User-Agent` in bunvex's words (`Bunvex/1.0`, DV-456) unless the app sets
//   one, and wait as long as the action may (reqwest has no timeout; Bun's idle timeout is turned off).
// - A `"use node"` action runs on Node in Convex, whose `fetch` takes `http:`, `https:` and `data:`; another
//   scheme fails as Node's does (`TypeError: fetch failed`, with Node's cause).
// - An isolate action's request goes through the operator's proxy, if any (`http-proxy.ts`); a refusal is
//   Convex's `TypeError`. A Node action's does not, as Convex's local Node executor's.
import { directFetch } from "@bunvex/core";
import { ActionTimeoutError } from "./action-timeout.ts";
import { RefusedRequest } from "./http-proxy.ts";

/** `RequestInit` options only Bun's `fetch` reads; an action's request goes out without them. */
const BUN_ONLY_OPTIONS = [
  "unix",
  "proxy",
  "tls",
  "s3",
  "timeout",
  "maxRedirects",
  "verbose",
  "decompress",
  "compress",
  "protocol",
] as const;

/** Convex's default `User-Agent` (`common/src/http/fetch.rs`, `Convex/1.0`), in bunvex's words (rule 5, DV-456). */
export const FETCH_USER_AGENT = "Bunvex/1.0";

/**
 * `send` with bunvex's default `User-Agent` when the request has none: OIDC discovery and JWKS requests, which
 * Convex sends with the same client as an action's `fetch` (`build_proxied_reqwest_client`, STUDY-142).
 */
export function withDefaultUserAgent(send: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.has("user-agent")) return send(input, init);
    headers.set("user-agent", FETCH_USER_AGENT);
    return send(input, { ...init, headers });
  }) as typeof fetch;
}

/** The URL a `fetch` call names, or null when it does not parse (the request itself then reports it). */
function urlOf(input: Parameters<typeof fetch>[0]): URL | null {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return null;
  }
}

/** `init` without Bun's own options (the same object when it has none). */
function webInit(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || !BUN_ONLY_OPTIONS.some((k) => k in init)) return init;
  const out: Record<string, unknown> = { ...init };
  for (const k of BUN_ONLY_OPTIONS) delete out[k];
  return out as RequestInit;
}

/** Convex's message for a scheme its `Request` refuses. */
export const unsupportedScheme = (protocol: string) =>
  new TypeError(
    `Unsupported URL scheme -- http and https are supported (scheme was ${protocol.slice(0, protocol.length - 1)})`,
  );

/** Convex's abort (`FetchAborted` as a `DOMException`), whatever the signal's reason. */
const aborted = () => new DOMException("The signal has been aborted", "AbortError");

const DARWIN = process.platform === "darwin";

/** How Rust prints the socket errors a connection fails with: the system's text and number (`os error N`). */
const OS_ERRORS: Record<string, [darwin: string, other: string]> = {
  ECONNREFUSED: ["Connection refused (os error 61)", "Connection refused (os error 111)"],
  ETIMEDOUT: ["Operation timed out (os error 60)", "Connection timed out (os error 110)"],
  EHOSTUNREACH: ["No route to host (os error 65)", "No route to host (os error 113)"],
  ENETUNREACH: ["Network is unreachable (os error 51)", "Network is unreachable (os error 101)"],
};

/** `getaddrinfo`'s text for a name that does not resolve (`gai_strerror`). */
const DNS_ERRORS: Record<string, [darwin: string, other: string]> = {
  ENOTFOUND: ["nodename nor servname provided, or not known", "Name or service not known"],
  EAI_AGAIN: ["temporary failure in name resolution", "Temporary failure in name resolution"],
};

/** A certificate or TLS failure, by Bun's code (BoringSSL's names). */
const TLS_CODE = /CERT|SSL|TLS|ISSUER|SELF_SIGNED|ALTNAME|HOSTNAME/;

/**
 * Convex's cause for a request that failed (reqwest's error with its sources, `{e:#}`), from Bun's error or
 * the screen's (`screenFailure`): `url` is reqwest's (the request's, without credentials).
 */
export function requestFailure(e: unknown, url: string): string {
  const { code, message } = (e ?? {}) as { code?: unknown; message?: unknown };
  const c = typeof code === "string" ? (code === "ConnectionRefused" ? "ECONNREFUSED" : code) : "";
  const head = `error sending request for url (${url}): client error`;
  const os = OS_ERRORS[c];
  if (os) return `${head} (Connect): tcp connect error: ${os[DARWIN ? 0 : 1]}`;
  const dns = DNS_ERRORS[c];
  if (dns) return `${head} (Connect): dns error: failed to lookup address information: ${dns[DARWIN ? 0 : 1]}`;
  if (c === "ECONNRESET") return `${head} (SendRequest): connection closed before message completed`;
  // Bun's own words, without its pointer to `verbose` and the URL it names (with its query string).
  const text = String(message ?? e)
    .replace(/ fetching \x22[^\x22]*\x22\. For more information, pass \x60verbose: true\x60.*$/s, "")
    .replace(/\. For more information, pass \x60verbose: true\x60.*$/s, "");
  if (TLS_CODE.test(c)) return `${head} (Connect): ${text}`;
  return `error sending request for url (${url}): ${text}`;
}

/** reqwest's form of a request's URL: without the credentials it sends as `Authorization`. */
function reqwestUrl(href: string): string {
  const u = new URL(href);
  u.username = "";
  u.password = "";
  return u.href;
}

/**
 * Convex's `fetchFailure`: the cause with the URL's query string, fragment and credentials dropped (where a
 * token would be), and `fetch to <url> failed: ` before a cause that does not name it.
 */
export function fetchFailure(url: string, cause: string): TypeError {
  const { origin, pathname, search, hash } = new URL(url);
  const target = `${origin}${pathname}`;
  const text = cause.replaceAll(url, () => target).replaceAll(`${target}${search}${hash}`, () => target);
  return new TypeError(text.includes(target) ? text : `fetch to ${target} failed: ${cause}`);
}

/** The error a failed request rejects with, as Convex's: its abort, the action's timeout as is, else `fetchFailure`. */
function failed(request: Request, e: unknown): unknown {
  if (e instanceof ActionTimeoutError) return e;
  if (request.signal.aborted || (e as { name?: unknown })?.name === "AbortError") return aborted();
  // A 407 is already Convex's message (its backend's own, not reqwest's).
  if (e instanceof RefusedRequest) return fetchFailure(request.url, e.message);
  return fetchFailure(request.url, requestFailure(e, reqwestUrl(request.url)));
}

/** The request an action's response answers (for its body's failures), and whether it was redirected. */
const REQUEST = Symbol("request");
const REDIRECTED = Symbol("redirected");

/**
 * A body's read failure as Convex's: reqwest's "error decoding response body" with the URL, or its abort. A
 * failure that is not the network's (`json()` on text) stays as it is.
 */
function bodyFailure(request: Request, e: unknown): unknown {
  if (e instanceof ActionTimeoutError) return e;
  if (request.signal.aborted || (e as { name?: unknown })?.name === "AbortError") return aborted();
  if (typeof (e as { code?: unknown })?.code !== "string") return e;
  return fetchFailure(request.url, "error decoding response body");
}

type Answering = Response & { [REQUEST]: Request; [REDIRECTED]?: boolean };

/** `body`, its read failures as Convex's. */
function mappingFailures(body: ReadableStream<Uint8Array>, request: Request): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (e) {
        throw bodyFailure(request, e);
      }
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

const READS = ["text", "json", "arrayBuffer", "bytes", "blob", "formData"] as const;

/** A getter or method named `name` on `proto` or the first of its prototypes that has one. */
function inherited(proto: object | null, name: string): PropertyDescriptor | undefined {
  for (let p = proto; p !== null; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    if (d !== undefined) return d;
  }
  return undefined;
}

/**
 * The prototype of an action's response: the fetched response's own (Bun's, so its native reads stay fast), whose
 * reads fail as Convex's, and `redirected` as Convex's loop sets it. Built from the response itself, not the global
 * `Response`, which another library (a DOM in tests) may have replaced; one per response prototype.
 */
function actionResponse(proto: object): object {
  const nativeBody = inherited(proto, "body")?.get;
  return Object.create(proto, {
    redirected: {
      get(this: Answering) {
        return this[REDIRECTED] ?? false;
      },
    },
    body: {
      get(this: Answering) {
        const body = (nativeBody?.call(this) ?? null) as ReadableStream<Uint8Array> | null;
        return body && mappingFailures(body, this[REQUEST]);
      },
    },
    ...Object.fromEntries(
      READS.flatMap((name) => {
        const read = inherited(proto, name)?.value as ((this: Response) => Promise<unknown>) | undefined;
        if (read === undefined) return [];
        return [
          [
            name,
            {
              value(this: Answering) {
                return read.call(this).catch((e) => Promise.reject(bodyFailure(this[REQUEST], e)));
              },
            },
          ],
        ];
      }),
    ),
  });
}

const ACTION_RESPONSES = new WeakMap<object, object>();

/** `r` as the response to `request` an action sees. */
function answering(r: Response, request: Request): Answering {
  const proto = Object.getPrototypeOf(r) as object;
  let wrapped = ACTION_RESPONSES.get(proto);
  if (wrapped === undefined) {
    wrapped = actionResponse(proto);
    ACTION_RESPONSES.set(proto, wrapped);
  }
  Object.setPrototypeOf(r, wrapped);
  const out = r as Answering;
  out[REQUEST] = request;
  return out;
}

/** The redirect statuses Convex follows. */
const REDIRECTS = [301, 302, 303, 307, 308];

/** The headers Convex drops when a redirect turns the request into a `GET`. */
const REQUEST_BODY_HEADERS = ["Content-Encoding", "Content-Language", "Content-Location", "Content-Type"];

/** Convex's `sameOrigin` (the origin, and the port again). */
const sameOrigin = (a: URL, b: URL) => a.origin === b.origin && a.port === b.port;

/**
 * An isolate action's `fetch` (HTTP actions too): `http:` and `https:` only, with the web's options, redirects
 * followed one request at a time as Convex's runtime follows them, and its errors. `resent` hears the body bytes of
 * each redirected request that went out (a 307 or 308 sends the body again): Convex meters every request, hop by hop
 * (`track_fetch_egress`), where the first one is metered around this `fetch`.
 */
export function isolateFetch(
  send: typeof fetch = directFetch,
  resent: (bytes: number) => void = () => {},
): typeof fetch {
  /** One request, never redirected by Bun: its response, or Convex's error. */
  const once = async (request: Request): Promise<Response> => {
    let r: Response;
    try {
      r = await send(request, { redirect: "manual", timeout: false } as RequestInit);
    } catch (e) {
      throw failed(request, e);
    }
    return answering(r, request);
  };
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = urlOf(input);
    if (url && url.protocol !== "http:" && url.protocol !== "https:") throw unsupportedScheme(url.protocol);
    let options = webInit(init);
    let request = input instanceof Request ? new Request(input, options) : new Request(String(input), options);
    if (!request.headers.has("user-agent")) request.headers.set("user-agent", FETCH_USER_AGENT);
    let response = await once(request);
    const mode = options?.redirect ?? "follow";
    if (mode === "manual") return response;
    for (let hops = 0; hops < 20; ) {
      if (!REDIRECTS.includes(response.status)) return response;
      if (mode === "error") throw new TypeError("fetch attempted redirect");
      const location = response.headers.get("Location");
      if (location === null) return response;
      hops++;
      options = options ?? {};
      const next = new URL(location, request.url);
      const headers = new Headers(request.headers);
      if (options.body instanceof ReadableStream) {
        // A stream was read by the first request: only a 303 (which drops the body) can go on.
        if (response.status === 303) options.body = null;
        else throw new TypeError("fetch cannot redirect with streamed body");
      }
      if (
        ((response.status === 301 || response.status === 302) && request.method === "POST") ||
        (response.status === 303 && !["GET", "HEAD"].includes(request.method))
      ) {
        options.method = "GET";
        options.body = null;
        for (const h of REQUEST_BODY_HEADERS) headers.delete(h);
      }
      if (!sameOrigin(new URL(request.url), next)) headers.delete("Authorization");
      const referrerPolicy = response.headers.get("Referrer-Policy");
      if (referrerPolicy) headers.set("Referrer-Policy", referrerPolicy);
      options.headers = headers;
      await response.body?.cancel().catch(() => {});
      request = new Request(next.href, options);
      const bytes = request.body ? (await request.clone().arrayBuffer()).byteLength : 0;
      response = await once(request);
      if (bytes > 0) resent(bytes);
      (response as Answering)[REDIRECTED] = true;
    }
    throw new TypeError("fetch too many redirects");
  }) as typeof fetch;
}

/** A `"use node"` action's `fetch`: what Node's takes (`data:` as well), failing as Node's otherwise. */
export function nodeFetch(send: typeof fetch = directFetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = urlOf(input);
    if (url && !["http:", "https:", "data:"].includes(url.protocol))
      return Promise.reject(
        new TypeError("fetch failed", {
          cause: new Error(url.protocol === "file:" ? "not implemented... yet..." : "unknown scheme"),
        }),
      );
    return send(input, webInit(init));
  }) as typeof fetch;
}

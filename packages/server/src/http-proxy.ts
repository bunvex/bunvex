// The operator's proxy for the requests made on an app's behalf (STUDY-80 §3.2), as Convex's
// `--convex-http-proxy` (crates/local_backend/src/config.rs; crates/common/src/http/fetch.rs,
// `build_proxied_reqwest_client`): an action's `fetch`, OIDC discovery and JWKS, and the log stream sinks
// but Sentry's go through it, so a screening proxy (Smokescreen) can refuse private addresses.
//
// - Every proxied request carries `Proxy-Authorization: <instance name>` (Convex's `custom_http_auth`); an
//   `https:` target is a `CONNECT` tunnel with the same header (Bun's `proxy: { url, headers }`).
// - A 407 response — Smokescreen's refusal, or any 407 — is an error naming the URL, never the response
//   (Convex: its headers would leak the proxy's details), with or without a proxy.
// - Without a proxy, Bun's `fetch` uses `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`, as `reqwest` does.
export type HttpProxy = {
  /** The proxy's URL (`http://host:port`). */
  url: string;
  /** Who is asking: the instance name, sent as `Proxy-Authorization`. */
  clientId: string;
  /**
   * bunvex's own screen (`address-screen.ts`) only: the secret its failure answers carry, so a target it could
   * not reach fails as it would without the screen (`screenFailure`), not as a `502` response.
   */
  failureToken?: string;
};

/** The header of the screen's failure answer: `<failureToken> <the socket's error code>`. */
export const SCREEN_FAILURE_HEADER = "bunvex-screen-failure";

/**
 * A target the screen could not reach, failing as Bun's `fetch` does without a proxy: a `TypeError` with the
 * socket's error code (`ConnectionRefused` as Bun names it, else the system's: `ETIMEDOUT`, `EHOSTUNREACH`, …).
 */
export function screenFailure(code: string): TypeError {
  const refused = code === "ECONNREFUSED";
  const e = new TypeError(
    refused ? "Unable to connect. Is the computer able to access the url?" : `${code}: the target is unreachable`,
  );
  return Object.assign(e, { code: refused ? "ConnectionRefused" : code });
}

/**
 * The status line a proxy answered a `CONNECT` with, when it was not 200: Bun 1.4.4 fails the `fetch` with
 * `ERR_PROXY_TUNNEL` ("Proxy refused to open a tunnel: 407 Proxy Authentication Required") instead of answering
 * the response, and the line is all that is left of it. Null for any other failure.
 */
function refusedTunnel(e: unknown): string | null {
  const { code, message } = (e ?? {}) as { code?: unknown; message?: unknown };
  const prefix = "Proxy refused to open a tunnel: ";
  return code === "ERR_PROXY_TUNNEL" && typeof message === "string" && message.startsWith(prefix)
    ? message.slice(prefix.length)
    : null;
}

/**
 * reqwest's message for a `CONNECT` the proxy did not open (hyper-util's `TunnelError`): `proxy authorization
 * required` for a 407, `unsuccessful` for any other status.
 */
const tunnelMessage = (href: string, status: string) =>
  `error sending request for url (${href}): client error (Connect): tunnel error: ${status === "407" ? "proxy authorization required" : "unsuccessful"}`;

/** A request a 407 refused: the message is Convex's (its clients'), naming the request's URL. */
export class RefusedRequest extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

/** The URL a `fetch` call names, normalized as Convex's `Url` prints it; null when it does not parse. */
function hrefOf(input: Parameters<typeof fetch>[0]): string | null {
  try {
    return new URL(input instanceof Request ? input.url : String(input)).href;
  } catch {
    return null;
  }
}

/**
 * `send` through `proxy` (when there is one) for `http:` / `https:` URLs, and a 407 answered as Convex's
 * clients answer it: `Request to <url> forbidden`, or — the proxy refusing an `https:` target's `CONNECT`,
 * which `reqwest` reports as a tunnel error — that error's message. The URL named is the request's: an
 * action's `fetch` follows redirects itself, one request per hop (`action-fetch.ts`), where OIDC's client
 * follows them inside `reqwest` and names the first.
 *
 * With bunvex's screen (`failureToken`), its answer for a target it could not reach is that failure.
 */
export function proxiedFetch(send: typeof fetch, proxy: HttpProxy | null): typeof fetch {
  const via = proxy ? { url: proxy.url, headers: { "Proxy-Authorization": proxy.clientId } } : null;
  const token = proxy?.failureToken;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = hrefOf(input);
    const web = href?.startsWith("http:") || href?.startsWith("https:");
    let r: Response;
    try {
      r = await send(input, via && web ? ({ ...init, proxy: via } as RequestInit) : init);
    } catch (e) {
      // A CONNECT that was not opened: the screen's failure (in its status line), else reqwest's tunnel error.
      const line = via && href?.startsWith("https:") ? refusedTunnel(e) : null;
      if (line === null || !href) throw e;
      const [status = "", from, code] = line.split(" ");
      if (token && status === "502" && from === token && code) throw screenFailure(code);
      throw new RefusedRequest(tunnelMessage(href, status), href);
    }
    if (token && r.status === 502) {
      const [from, code] = (r.headers.get(SCREEN_FAILURE_HEADER) ?? "").split(" ");
      if (from === token && code) {
        await r.body?.cancel().catch(() => {});
        throw screenFailure(code);
      }
    }
    if (r.status !== 407 || !href) return r;
    await r.body?.cancel().catch(() => {});
    throw new RefusedRequest(
      via && href.startsWith("https:") ? tunnelMessage(href, "407") : `Request to ${href} forbidden`,
      href,
    );
  }) as typeof fetch;
}

/** The proxy from `httpProxy` or `BUNVEX_HTTP_PROXY`, checked (http or https); null for none. Throws when invalid. */
export function httpProxyUrl(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`invalid proxy URL '${value}'`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`invalid proxy URL '${value}': the scheme must be http or https`);
  return u.href;
}

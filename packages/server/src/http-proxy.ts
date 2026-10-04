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
};

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
 * which `reqwest` reports as a tunnel error — that error's message.
 *
 * The URL named is the request's; with `hop`, the redirect's that was refused — an action's `fetch` follows
 * redirects in JS, one request per hop (`udf-runtime/src/26_fetch.ts`), where OIDC's client follows them
 * inside `reqwest` and names the first.
 */
export function proxiedFetch(send: typeof fetch, proxy: HttpProxy | null, hop = false): typeof fetch {
  const via = proxy ? { url: proxy.url, headers: { "Proxy-Authorization": proxy.clientId } } : null;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = hrefOf(input);
    const web = href?.startsWith("http:") || href?.startsWith("https:");
    const r = await send(input, via && web ? ({ ...init, proxy: via } as RequestInit) : init);
    if (r.status !== 407 || !href) return r;
    await r.body?.cancel().catch(() => {});
    const url = hop && r.url ? r.url : href;
    throw new RefusedRequest(
      via && url.startsWith("https:")
        ? `error sending request for url (${url}): client error (Connect): tunnel error: proxy authorization required`
        : `Request to ${url} forbidden`,
      url,
    );
  }) as typeof fetch;
}

/**
 * The refusal as an action sees it: a `TypeError` whose URL has no query string or fragment, as Convex's
 * `fetch` (`udf-runtime/src/26_fetch.ts`) rethrows it — the query is where a token would be.
 */
export function refusedInAction(e: RefusedRequest): TypeError {
  const u = new URL(e.url);
  return new TypeError(e.message.replaceAll(e.url, `${u.origin}${u.pathname}`));
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

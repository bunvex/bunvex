// An action's `fetch` (STUDY-80): what it may reach, as Convex's runtime allows.
//
// - Convex's isolate builds every request with its own `Request`, which accepts only `http:` and `https:`
//   (`udf-runtime/src/23_request.ts`, `validateURL`), and reads only the web's `RequestInit` fields. Bun's
//   `fetch` also reads local files (`file:`), S3 objects with the process's credentials (`s3:`), and takes
//   `unix` (a Unix socket), `proxy` and `tls` options. An action gets none of them: another scheme is
//   Convex's `TypeError`, and those options are dropped, as Convex ignores them.
// - A `"use node"` action runs on Node in Convex, whose `fetch` takes `http:`, `https:` and `data:`; another
//   scheme fails as Node's does (`TypeError: fetch failed`, with Node's cause).
import { directFetch } from "@bunvex/core";

/** `RequestInit` options only Bun's `fetch` reads; an action's request goes out without them. */
const BUN_ONLY_OPTIONS = ["unix", "proxy", "tls", "s3"] as const;

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

/** An isolate action's `fetch` (HTTP actions too): `http:` and `https:` only, with the web's options. */
export function isolateFetch(send: typeof fetch = directFetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = urlOf(input);
    if (url && url.protocol !== "http:" && url.protocol !== "https:")
      return Promise.reject(unsupportedScheme(url.protocol));
    return send(input, webInit(init));
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

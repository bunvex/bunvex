// The admin HTTP routes, as Convex's dashboard calls them (`dashboard-common/src/lib/fetching.ts`
// `deploymentFetch`; STUDY-149 §1.1): the admin key in `Authorization` under bunvex's scheme (DV-97) and the
// client header naming the dashboard (`Convex-Client: dashboard-0.0.0` there), which also turns on the log
// stream's `links` (STUDY-131 AD-27). Failures become the contract's `DataSourceError`s.
import { DataSourceError, type DataSourceErrorCode } from "@bunvex/dashboard/data-source";
import pkg from "../package.json" with { type: "json" };

/** The dashboard's client header value, `dashboard-<version>` (STUDY-149 §3.3). */
export const CLIENT_NAME = `dashboard-${pkg.version}`;

/** The headers every admin request carries. */
export const adminHeaders = (adminKey: string): Record<string, string> => ({
  Authorization: `Bunvex ${adminKey}`,
  "Bunvex-Client": CLIENT_NAME,
});

/** `base` and an absolute path joined, whatever trailing slashes `base` has (Convex's `joinUrlPath`). */
export const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`;

/** A failed response's code: 401 and 403 unauthorized, 404 not found, another 4xx invalid, the rest unavailable. */
export function codeOfStatus(status: number): DataSourceErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "invalid_request";
  return "unavailable";
}

/** A failed response, with its status (the log loop stops on a 403 only, as Convex's). */
export class ResponseError extends DataSourceError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(codeOfStatus(status), message);
  }
}

/** The error of a failed response: the server's `{code, message}` body when it sent one, else the text. */
export async function responseError(res: Response): Promise<ResponseError> {
  const text = await res.text().catch(() => "");
  let message = text || `${res.status} ${res.statusText}`;
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body.message === "string") message = body.message;
  } catch {
    // not JSON: the text as it is
  }
  return new ResponseError(res.status, message);
}

/** The `fetch` the source calls: the global one by default, or a host's (tests pass their own). */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type AdminHttpOptions = {
  url: string;
  adminKey: string;
  /** Default: the global `fetch`. */
  fetch?: FetchFn;
};

export type AdminRequest = {
  method?: "GET" | "POST";
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as it is (an import's part), instead of `body`. */
  bytes?: Blob;
  signal?: AbortSignal;
};

/** Calls the deployment's admin routes with the admin key. */
export class AdminHttp {
  readonly url: string;
  private readonly adminKey: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: AdminHttpOptions) {
    this.url = opts.url;
    this.adminKey = opts.adminKey;
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * The response of `path` (with its query string), when it succeeded. A failed response, or a network error,
   * throws a `DataSourceError`; an abort rejects with the signal's reason.
   */
  async request(path: string, req: AdminRequest = {}): Promise<Response> {
    const headers = adminHeaders(this.adminKey);
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchFn(joinUrl(this.url, path), {
        method: req.method ?? (req.body === undefined && req.bytes === undefined ? "GET" : "POST"),
        headers,
        ...(req.body !== undefined && { body: JSON.stringify(req.body) }),
        ...(req.bytes !== undefined && { body: req.bytes }),
        ...(req.signal && { signal: req.signal }),
      });
    } catch (e) {
      if (req.signal?.aborted) throw req.signal.reason;
      throw new DataSourceError("unavailable", e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw await responseError(res);
    return res;
  }

  /**
   * A request without the admin key's header, answered whatever its status: for a route that takes the key in its
   * body (`/api/run_test_function`, as Convex's dashboard calls it). A network error throws `unavailable`.
   */
  async unauthenticated(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(joinUrl(this.url, path), init);
    } catch (e) {
      if (init.signal?.aborted) throw init.signal.reason;
      throw new DataSourceError("unavailable", e instanceof Error ? e.message : String(e));
    }
  }

  /** `request`, read as JSON. */
  async json<T>(path: string, req?: AdminRequest): Promise<T> {
    const res = await this.request(path, req);
    try {
      return (await res.json()) as T;
    } catch {
      if (req?.signal?.aborted) throw req.signal.reason;
      throw new DataSourceError("unavailable", `${path} answered something that is not JSON`);
    }
  }

  /** `request`, read as text. */
  async text(path: string, req?: AdminRequest): Promise<string> {
    return (await this.request(path, req)).text();
  }
}

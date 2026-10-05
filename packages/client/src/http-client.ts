// `BunvexHttpClient`, the counterpart of Convex's `ConvexHttpClient` (`browser/http_client.ts`, STUDY-26 §9):
// one-shot calls over HTTP, for scripts and servers that do not need a socket. Mutations run one at a time,
// in order, unless `skipQueue`; `consistentQuery` reads every query of the client at one timestamp.
import {
  type AnyFunctionReference,
  type FunctionArgs,
  type FunctionReturnType,
  getFunctionName,
  makeFunctionReference,
  type OptionalRestArgs,
} from "@bunvex/protocol";
import { BunvexError, fromJsonValue, type JSONValue, toJsonValue, type Value } from "@bunvex/values";
import { parseArgs } from "./args.ts";
import { validateDeploymentUrl } from "./base-client.ts";
import {
  instantiateDefaultLogger,
  instantiateNoopLogger,
  type Logger,
  logForFunction,
  type UdfType,
} from "./logging.ts";
import { VERSION } from "./version.ts";

export const STATUS_CODE_OK = 200;
export const STATUS_CODE_BAD_REQUEST = 400;
/** What Convex's hosted backend answers for a function error (bunvex answers 200 with `status: "error"`). */
export const STATUS_CODE_UDF_FAILED = 560;

let specifiedFetch: typeof globalThis.fetch | undefined;
/** Replace `fetch` for every HTTP client (e.g. an old runtime without one). */
export function setFetch(f: typeof globalThis.fetch) {
  specifiedFetch = f;
}

export type HttpMutationOptions = {
  /** Run now, not after the client's earlier mutations. */
  skipQueue: boolean;
};

/** Extra `fetch` options for every request (e.g. `cache: "no-store"` for Next.js). */
export type FetchOptions = { cache: "force-cache" | "no-store" };

type Ref<T extends "query" | "mutation" | "action"> = AnyFunctionReference & { _type: T };

type UdfResponse =
  | { status: "success"; value: JSONValue; logLines?: string[] }
  | { status: "error"; errorMessage: string; errorData?: JSONValue; logLines?: string[] };

export class BunvexHttpClient {
  private readonly address: string;
  private auth: string | undefined;
  private adminAuth: string | undefined;
  private encodedTsPromise: Promise<string> | undefined;
  private debug = true;
  private fetchOptions: FetchOptions | undefined;
  private readonly fetch: typeof globalThis.fetch | undefined;
  private readonly logger: Logger;
  private readonly mutationQueue: {
    mutation: Ref<"mutation">;
    args: Record<string, Value>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  private isProcessingQueue = false;

  /** @param address - The deployment's URL, e.g. `http://localhost:3210`. */
  constructor(
    address: string,
    options: {
      skipDeploymentUrlCheck?: boolean;
      logger?: Logger | boolean;
      auth?: string;
      fetch?: typeof globalThis.fetch;
    } = {},
  ) {
    if (options.skipDeploymentUrlCheck !== true) validateDeploymentUrl(address);
    this.logger =
      options.logger === false
        ? instantiateNoopLogger({ verbose: false })
        : options.logger !== true && options.logger
          ? options.logger
          : instantiateDefaultLogger({ verbose: false });
    this.address = address;
    this.fetch = options.fetch;
    if (options.auth) this.setAuth(options.auth);
  }

  /** The URL of the HTTP API (`<address>/api`). */
  backendUrl(): string {
    return `${this.address}/api`;
  }

  get url(): string {
    return this.address;
  }

  /** An OpenID Connect ID token for later calls (sent as `Authorization: Bearer …`). */
  setAuth(value: string) {
    this.clearAuth();
    this.auth = value;
  }

  /** @internal An admin key, optionally acting as a user (sent as `Authorization: Bunvex …`, STUDY-26 H2). */
  setAdminAuth(token: string, actingAsIdentity?: Record<string, unknown>) {
    this.clearAuth();
    if (actingAsIdentity === undefined) {
      this.adminAuth = token;
      return;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(actingAsIdentity));
    this.adminAuth = `${token}:${btoa(String.fromCodePoint(...bytes))}`;
  }

  clearAuth() {
    this.auth = undefined;
    this.adminAuth = undefined;
  }

  /** Whether the functions' log lines are printed (default: yes). */
  setDebug(debug: boolean) {
    this.debug = debug;
  }

  setFetchOptions(fetchOptions: FetchOptions) {
    this.fetchOptions = fetchOptions;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json", "Bunvex-Client": `npm-${VERSION}` };
    if (this.adminAuth) headers.Authorization = `Bunvex ${this.adminAuth}`;
    else if (this.auth) headers.Authorization = `Bearer ${this.auth}`;
    return headers;
  }

  private localFetch(): typeof globalThis.fetch {
    return this.fetch ?? specifiedFetch ?? fetch;
  }

  /** POST a call and read Convex's `UdfResponse`: the value, or the function's error (with its data). */
  private async call(endpoint: string, body: Record<string, unknown>, type: UdfType, name: string): Promise<unknown> {
    const response = await this.localFetch()(`${this.address}/api/${endpoint}`, {
      ...this.fetchOptions,
      // As Convex's client: results in the encoded form whatever the server's default (STUDY-67 H3).
      body: JSON.stringify({ ...body, format: "encoded_json" }),
      method: "POST",
      headers: this.headers(),
    });
    if (!response.ok && response.status !== STATUS_CODE_UDF_FAILED) throw new Error(await response.text());
    const resp = (await response.json()) as UdfResponse;
    if (this.debug) for (const line of resp.logLines ?? []) logForFunction(this.logger, "info", type, name, line);
    switch (resp.status) {
      case "success":
        return fromJsonValue(resp.value);
      case "error": {
        if (resp.errorData === undefined) throw new Error(resp.errorMessage);
        const e = new BunvexError(resp.errorMessage);
        (e as BunvexError<Value>).data = fromJsonValue(resp.errorData) as Value;
        throw e;
      }
      default:
        throw new Error(`Invalid response: ${JSON.stringify(resp)}`);
    }
  }

  /** Run a query at the latest state. */
  async query<Q extends Ref<"query">>(query: Q | string, ...args: OptionalRestArgs<Q>): Promise<FunctionReturnType<Q>> {
    const name = getFunctionName(query);
    const queryArgs = parseArgs(args[0] as Record<string, Value> | undefined);
    return (await this.call(
      "query",
      { path: name, args: [toJsonValue(queryArgs)] },
      "query",
      name,
    )) as FunctionReturnType<Q>;
  }

  /**
   * Run a query at the timestamp of this client's first `consistentQuery`: all of them read one snapshot.
   * (Deprecated in Convex, since a long-lived client ends up reading old data; kept for parity.)
   */
  async consistentQuery<Q extends Ref<"query">>(
    query: Q | string,
    ...args: OptionalRestArgs<Q>
  ): Promise<FunctionReturnType<Q>> {
    const name = getFunctionName(query);
    const queryArgs = parseArgs(args[0] as Record<string, Value> | undefined);
    const ts = await this.getTimestamp();
    return (await this.call(
      "query_at_ts",
      { path: name, args: [toJsonValue(queryArgs)], ts },
      "query",
      name,
    )) as FunctionReturnType<Q>;
  }

  private getTimestamp(): Promise<string> {
    this.encodedTsPromise ??= (async () => {
      const response = await this.localFetch()(`${this.address}/api/query_ts`, {
        ...this.fetchOptions,
        method: "POST",
        headers: this.headers(),
      });
      if (!response.ok) throw new Error(await response.text());
      return ((await response.json()) as { ts: string }).ts;
    })();
    return this.encodedTsPromise;
  }

  private mutationInner(mutation: Ref<"mutation">, args: Record<string, Value>): Promise<unknown> {
    const name = getFunctionName(mutation);
    return this.call("mutation", { path: name, args: [toJsonValue(args)] }, "mutation", name);
  }

  private async processMutationQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    while (this.mutationQueue.length > 0) {
      const { mutation, args, resolve, reject } = this.mutationQueue.shift()!;
      try {
        resolve(await this.mutationInner(mutation, args));
      } catch (error) {
        reject(error);
      }
    }
    this.isProcessingQueue = false;
  }

  /** Run a mutation: after this client's earlier ones (in order), or now with `{ skipQueue: true }`. */
  async mutation<M extends Ref<"mutation">>(
    mutation: M | string,
    args?: FunctionArgs<M>,
    options?: HttpMutationOptions,
  ): Promise<FunctionReturnType<M>> {
    const ref = (
      typeof mutation === "string" ? makeFunctionReference<"mutation">(mutation) : mutation
    ) as Ref<"mutation">;
    const mutationArgs = parseArgs(args as Record<string, Value> | undefined);
    if (options?.skipQueue) return (await this.mutationInner(ref, mutationArgs)) as FunctionReturnType<M>;
    return (await new Promise((resolve, reject) => {
      this.mutationQueue.push({ mutation: ref, args: mutationArgs, resolve, reject });
      void this.processMutationQueue();
    })) as FunctionReturnType<M>;
  }

  async action<A extends Ref<"action">>(
    action: A | string,
    ...args: OptionalRestArgs<A>
  ): Promise<FunctionReturnType<A>> {
    const name = getFunctionName(action);
    const actionArgs = parseArgs(args[0] as Record<string, Value> | undefined);
    return (await this.call(
      "action",
      { path: name, args: [toJsonValue(actionArgs)] },
      "action",
      name,
    )) as FunctionReturnType<A>;
  }

  /**
   * @internal Run any function by its own kind, internal ones included (Convex's `function`, `/api/function`):
   * the server requires an admin key (`setAdminAuth`). Its arguments are sent as the object itself, not in an
   * array. `componentPath` names a component's function; bunvex has none (STUDY-62), so only the root's.
   */
  async function<F extends Ref<"query" | "mutation" | "action">>(
    anyFunction: F | string,
    componentPath?: string,
    ...args: OptionalRestArgs<F>
  ): Promise<FunctionReturnType<F>> {
    const name = getFunctionName(anyFunction);
    const functionArgs = parseArgs(args[0] as Record<string, Value> | undefined);
    return (await this.call(
      "function",
      { componentPath, path: name, args: toJsonValue(functionArgs) },
      "any",
      name,
    )) as FunctionReturnType<F>;
  }
}

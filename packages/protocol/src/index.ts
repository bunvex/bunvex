// Package @bunvex/protocol — the messages between clients and a bunvex server: the HTTP API's calls, the sync
// protocol v1 (Convex's, STUDY-23; the first, unversioned v0 was deleted, P2), and function references.

// ---------------------------------------------------------------- HTTP one-shot calls
// POST /api/{query,mutation,action}
export type FunctionKind = "query" | "mutation" | "action";
/** `args` is the arguments object, or an array holding it (what Convex's clients send). */
export type CallRequest = { path: string; args?: unknown };
/**
 * Convex's `UdfResponse`. A function error still answers HTTP 200. `errorData` is a `BunvexError`'s data;
 * `logLines` are the function's console lines (`[LEVEL] …`), omitted when empty or redacted. A failure of
 * the request or of the server (not of the function) answers 4xx/5xx with a `RequestError` body instead.
 */
export type CallResponse =
  | { status: "success"; value: unknown; logLines?: string[] }
  | { status: "error"; errorMessage: string; errorData?: unknown; logLines?: string[] };
export type RequestError = { code: string; message: string };

// ---------------------------------------------------------------- function references (STUDY-26 C3)
export {
  type AnyApi,
  type AnyFunctionReference,
  anyApi,
  type DefaultFunctionArgs,
  type EmptyObject,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  type FunctionType,
  type FunctionVisibility,
  functionName,
  getFunctionName,
  makeFunctionReference,
  type OptionalRestArgs,
} from "./api.ts";

// ---------------------------------------------------------------- v1 (STUDY-23): Convex's sync protocol
export * as v1 from "./v1.ts";

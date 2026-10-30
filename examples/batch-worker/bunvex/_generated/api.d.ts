/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `bunvex dev`.
 * @module
 */

import type * as aggregates from "../aggregates.js";
import type * as example from "../example.js";
import type * as rateLimited from "../rateLimited.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "@bunvex/server";

declare const fullApi: ApiFromModules<{
  aggregates: typeof aggregates;
  example: typeof example;
  rateLimited: typeof rateLimited;
}>;

/**
 * A utility for referencing bunvex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing bunvex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  batchWorker: import("@bunvex/batch-worker/_generated/component.js").ComponentApi<"batchWorker">;
  rateLimiter: import("@bunvex/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};

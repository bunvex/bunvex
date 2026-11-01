/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `bunvex dev`.
 * @module
 */

import type * as boxes from "../boxes.js";
import type * as checkboxes from "../checkboxes.js";
import type * as example from "../example.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "@bunvex/server";

declare const fullApi: ApiFromModules<{
  boxes: typeof boxes;
  checkboxes: typeof checkboxes;
  example: typeof example;
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
  shardedCounter: import("@bunvex/sharded-counter/_generated/component.js").ComponentApi<"shardedCounter">;
  checkboxCounter: import("@bunvex/sharded-counter/_generated/component.js").ComponentApi<"checkboxCounter">;
};

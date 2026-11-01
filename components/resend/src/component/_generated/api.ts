/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `bunvex dev`.
 * @module
 */

import type * as lib from "../lib.js";
import type * as shared from "../shared.js";
import type * as utils from "../utils.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "@bunvex/server";
import { anyApi, componentsGeneric } from "@bunvex/server";

const fullApi: ApiFromModules<{
  lib: typeof lib;
  shared: typeof shared;
  utils: typeof utils;
}> = anyApi as any;

/**
 * A utility for referencing bunvex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing bunvex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  rateLimiter: import("@bunvex/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  emailWorkpool: import("@bunvex/workpool/_generated/component.js").ComponentApi<"emailWorkpool">;
  callbackWorkpool: import("@bunvex/workpool/_generated/component.js").ComponentApi<"callbackWorkpool">;
};

/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `bunvex dev`.
 * @module
 */

import type * as internal_ from "../internal.js";
import type * as lib from "../lib.js";
import type * as time from "../time.js";
import type * as worker from "../worker.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "@bunvex/server";
import { anyApi, componentsGeneric } from "@bunvex/server";

const fullApi: ApiFromModules<{
  internal: typeof internal_;
  lib: typeof lib;
  time: typeof time;
  worker: typeof worker;
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
  batchWorker: import("@bunvex/batch-worker/_generated/component.js").ComponentApi<"batchWorker">;
};

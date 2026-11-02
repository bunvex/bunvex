/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `bunvex dev`.
 * @module
 */

import type { ApiFromModules, FilterApi, FunctionReference } from "@bunvex/server";
import { anyApi, componentsGeneric } from "@bunvex/server";
import type * as commonPasswords from "../commonPasswords.js";
import type * as public_ from "../public.js";
import type * as validation from "../validation.js";

const fullApi: ApiFromModules<{
  commonPasswords: typeof commonPasswords;
  public: typeof public_;
  validation: typeof validation;
}> = anyApi as any;

/**
 * A utility for referencing bunvex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<typeof fullApi, FunctionReference<any, "public">> = anyApi as any;

/**
 * A utility for referencing bunvex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  rateLimiter: import("@bunvex/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};

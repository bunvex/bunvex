/* eslint-disable */
/**
 * Generated utilities for implementing server-side bunvex query and mutation functions.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `bunvex dev`.
 * @module
 */

import {
  actionGeneric,
  httpActionGeneric,
  queryGeneric,
  mutationGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
} from "bunvex/server";

/**
 * Define a query in this bunvex app's public API, readable by clients.
 */
export const query = queryGeneric;

/**
 * Define a query that only other bunvex functions can call.
 */
export const internalQuery = internalQueryGeneric;

/**
 * Define a mutation in this bunvex app's public API, callable by clients.
 */
export const mutation = mutationGeneric;

/**
 * Define a mutation that only other bunvex functions can call.
 */
export const internalMutation = internalMutationGeneric;

/**
 * Define an action in this bunvex app's public API: it may call third-party services.
 */
export const action = actionGeneric;

/**
 * Define an action that only other bunvex functions can call.
 */
export const internalAction = internalActionGeneric;

/**
 * Define an HTTP action, served by the router exported from `http.ts`.
 */
export const httpAction = httpActionGeneric;

/**
 * The deployment's environment variables.
 */
export const env = process.env;

/* eslint-disable */
/**
 * Generated utilities for implementing server-side bunvex query and mutation functions.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `bunvex dev`.
 * @module
 */

import type {
  ActionBuilder,
  HttpActionBuilder,
  MutationBuilder,
  QueryBuilder,
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
  GenericDatabaseReader,
  GenericDatabaseWriter,
} from "bunvex/server";
import type { DataModel } from "./dataModel.js";

/**
 * Define a query in this bunvex app's public API, readable by clients.
 */
export declare const query: QueryBuilder<DataModel, "public">;

/**
 * Define a query that only other bunvex functions can call.
 */
export declare const internalQuery: QueryBuilder<DataModel, "internal">;

/**
 * Define a mutation in this bunvex app's public API, callable by clients.
 */
export declare const mutation: MutationBuilder<DataModel, "public">;

/**
 * Define a mutation that only other bunvex functions can call.
 */
export declare const internalMutation: MutationBuilder<DataModel, "internal">;

/**
 * Define an action in this bunvex app's public API: it may call third-party services.
 */
export declare const action: ActionBuilder<DataModel, "public">;

/**
 * Define an action that only other bunvex functions can call.
 */
export declare const internalAction: ActionBuilder<DataModel, "internal">;

/**
 * Define an HTTP action, served by the router exported from `http.ts`.
 */
export declare const httpAction: HttpActionBuilder;

/**
 * The deployment's environment variables.
 */
export declare const env: Record<string, string | undefined>;

/** The context of every query: a database reader, `auth` and `storage`. */
export type QueryCtx = GenericQueryCtx<DataModel>;

/** The context of every mutation: a database writer, `auth`, `storage` and `scheduler`. */
export type MutationCtx = GenericMutationCtx<DataModel>;

/** The context of every action: `runQuery`, `runMutation`, `runAction`, `auth`, `storage` and `scheduler`. */
export type ActionCtx = GenericActionCtx<DataModel>;

/** Reading the database (`ctx.db` in queries). */
export type DatabaseReader = GenericDatabaseReader<DataModel>;

/** Reading and writing the database (`ctx.db` in mutations). */
export type DatabaseWriter = GenericDatabaseWriter<DataModel>;

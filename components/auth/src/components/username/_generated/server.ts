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
  roomGeneric,
  presenceGeneric,
} from "@bunvex/server";
import type {
  ActionBuilder,
  HttpActionBuilder,
  MutationBuilder,
  QueryBuilder,
  RoomBuilder,
  PresenceBuilder,
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
  GenericDatabaseReader,
  GenericDatabaseWriter,
  SystemTableNames,
  TableNamesInDataModel,
} from "@bunvex/server";
import { type TableValidators, v as untypedV } from "@bunvex/values";
import type { DataModel } from "./dataModel.js";

/**
 * Define a query in this bunvex app's public API, readable by clients.
 */
export const query: QueryBuilder<DataModel, "public"> = queryGeneric;

/**
 * Define a query that only other bunvex functions can call.
 */
export const internalQuery: QueryBuilder<DataModel, "internal"> = internalQueryGeneric;

/**
 * Define a mutation in this bunvex app's public API, callable by clients.
 */
export const mutation: MutationBuilder<DataModel, "public"> = mutationGeneric;

/**
 * Define a mutation that only other bunvex functions can call.
 */
export const internalMutation: MutationBuilder<DataModel, "internal"> = internalMutationGeneric;

/**
 * Define an action in this bunvex app's public API: it may call third-party services.
 */
export const action: ActionBuilder<DataModel, "public"> = actionGeneric;

/**
 * Define an action that only other bunvex functions can call.
 */
export const internalAction: ActionBuilder<DataModel, "internal"> = internalActionGeneric;

/**
 * Define an HTTP action, served by the router exported from `http.ts`.
 */
export const httpAction: HttpActionBuilder = httpActionGeneric;

/**
 * Define a room: members, their presence and events, held in server memory beside the database.
 */
export const room: RoomBuilder<DataModel> = roomGeneric;

/**
 * Define a presence scope: a signed-in user's state, present while any of their connections is.
 */
export const presence: PresenceBuilder<DataModel> = presenceGeneric;

/**
 * The deployment's environment variables.
 */
export const env: Record<string, string | undefined> = (
  globalThis as unknown as { process: { env: Record<string, string | undefined> } }
).process.env;

/**
 * Validators, as `v` from bunvex/values, with `v.id` typed by this app's tables and the system tables: editors
 * complete them, and a misspelled table is a type error (any name, with no schema or `strictTableNameTypes: false`).
 */
export const v: TableValidators<TableNamesInDataModel<DataModel> | SystemTableNames> = untypedV;

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

// The component's function builders (STUDY-196 §1.6): `_generated/server`'s, with `ctx.log`, a logger at the
// `LOG_LEVEL` the parent binds, read at the start of each call. Every handler and helper takes these ctx types.
import { customCtx, customMutation, customQuery } from "@bunvex/helpers/server/customFunctions";
import {
  type MutationCtx as BaseMutationCtx,
  type QueryCtx as BaseQueryCtx,
  internalMutation as baseInternalMutation,
  internalQuery as baseInternalQuery,
  mutation as baseMutation,
  query as baseQuery,
  env,
} from "./_generated/server";
import { createLogger, type Logger, type LogLevel } from "./logging";

// `env` is untyped in bunvex's `_generated/server` (DV-176); the push checked the binding against `logLevel`.
const withLogger = customCtx(() => ({ log: createLogger(env.LOG_LEVEL as LogLevel | undefined) }));

export const query = customQuery(baseQuery, withLogger);
export const internalQuery = customQuery(baseInternalQuery, withLogger);
export const mutation = customMutation(baseMutation, withLogger);
export const internalMutation = customMutation(baseInternalMutation, withLogger);

export type QueryCtx = BaseQueryCtx & { log: Logger };
export type MutationCtx = BaseMutationCtx & { log: Logger };

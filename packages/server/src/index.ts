// Package @bunvex/server — the function runtime, the transports (HTTP + WebSocket sync) and configuration.
export { defineSchema, defineTable } from "@bunvex/core";
// Function references, as Convex's `convex/server` exports them (STUDY-26 C3).
export {
  type AnyApi,
  anyApi,
  type FunctionReference,
  getFunctionName,
  makeFunctionReference,
} from "@bunvex/protocol";
export { type CronJob, Crons, cronJobs, type DayOfWeek, type Schedule } from "./cron.ts";
export {
  type ActionCtx,
  type ArgsOf,
  type ArgsValidator,
  action,
  type FunctionDef,
  Functions,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./functions.ts";
export { paginationOptsValidator, paginationResultValidator } from "./pagination.ts";
export { openPersistence, type PersistenceConfig, persistenceConfigFromEnv } from "./persistence.ts";
export { type SchedulableFunction, ScheduledJobExecutor, type Scheduler, type SchedulerOptions } from "./scheduler.ts";
export { createServer, type ServerOptions } from "./server.ts";

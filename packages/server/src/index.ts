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
// Admin keys (STUDY-34): byte for byte Convex's.
export {
  ADMIN_KEY_PURPOSE,
  type AdminKeyIdentity,
  AdminKeys,
  adminKeyCipherKey,
  BadAdminKeyError,
  checkAdminKey,
  DEPLOYMENT_OPS,
  type DeploymentOp,
  issueAdminKey,
  READ_ONLY_OPERATIONS,
} from "./admin-keys.ts";
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
export {
  type HttpActionCtx,
  type HttpActionHandler,
  HttpRouter,
  httpAction,
  httpRouter,
  type PublicHttpAction,
  ROUTABLE_HTTP_METHODS,
  type RoutableMethod,
  type RouteSpec,
} from "./router.ts";
export { type SchedulableFunction, ScheduledJobExecutor, type Scheduler, type SchedulerOptions } from "./scheduler.ts";
export { createServer, type ServerOptions } from "./server.ts";

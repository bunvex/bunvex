// Package @bunvex/server — the function runtime, the transports (HTTP + WebSocket sync) and configuration.

// The data model and database as types, as Convex's `convex/server` exports them (`_generated/` imports them).
export type {
  AnyDataModel,
  DataModelFromSchemaDefinition,
  DocumentByInfo,
  DocumentByName,
  Expression,
  FieldPaths,
  FilterBuilder,
  GenericDatabaseReader,
  GenericDatabaseWriter,
  GenericDataModel,
  GenericDocument,
  GenericFieldPaths,
  GenericTableInfo,
  Indexes,
  IndexNames,
  IndexRange,
  IndexRangeBuilder,
  NamedIndex,
  NamedTableInfo,
  OrderedQuery,
  PaginationResultOf as PaginationResult,
  Query,
  QueryInitializer,
  SystemDataModel,
  SystemFields,
  SystemIndexes,
  SystemTableNames,
  TableNamesInDataModel,
  WithOptionalSystemFields,
  WithoutSystemFields,
} from "@bunvex/core";
export { defineSchema, defineTable } from "@bunvex/core";
// Function references, as Convex's `convex/server` exports them (STUDY-26 C3).
export {
  type AnyApi,
  anyApi,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  type FunctionType,
  type FunctionVisibility,
  getFunctionName,
  makeFunctionReference,
  type OptionalRestArgs,
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
export type {
  ApiFromModules,
  ConvertReturnType,
  FilterApi,
  FunctionReferenceFromExport,
} from "./api-types.ts";
export { type CronJob, Crons, cronJobs, type DayOfWeek, type Schedule } from "./cron.ts";
export {
  type ActionCtx,
  type ArgsOf,
  type ArgsValidator,
  action,
  actionGeneric,
  type FunctionDef,
  Functions,
  internalAction,
  internalActionGeneric,
  internalMutation,
  internalMutationGeneric,
  internalQuery,
  internalQueryGeneric,
  type MutationCtx,
  mutation,
  mutationGeneric,
  type QueryCtx,
  query,
  queryGeneric,
} from "./functions.ts";
export { paginationOptsValidator, paginationResultValidator } from "./pagination.ts";
export { openPersistence, type PersistenceConfig, persistenceConfigFromEnv } from "./persistence.ts";
export type {
  ActionBuilder,
  ArgsArray,
  ArgsArrayToObject,
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
  HttpActionBuilder,
  MutationBuilder,
  QueryBuilder,
  RegisteredAction,
  RegisteredMutation,
  RegisteredQuery,
} from "./registration.ts";
export {
  type HttpActionCtx,
  type HttpActionHandler,
  HttpRouter,
  httpAction,
  httpActionGeneric,
  httpRouter,
  type PublicHttpAction,
  ROUTABLE_HTTP_METHODS,
  type RoutableMethod,
  type RouteSpec,
} from "./router.ts";
export {
  type SchedulableFunction,
  type SchedulableFunctionReference,
  ScheduledJobExecutor,
  type Scheduler,
  type SchedulerOptions,
} from "./scheduler.ts";
export { createServer, type ServerOptions } from "./server.ts";

// Package @bunvex/server — the function runtime, the transports (HTTP + WebSocket sync) and configuration.

// Identity and the auth config (STUDY-27), as Convex's `convex/server` exports them.
export type { AuthConfig, AuthProvider, UserIdentity, UserIdentityAttributes } from "@bunvex/auth";
// The data model and database as types, as Convex's `convex/server` exports them (`_generated/` imports them).
export type {
  AnyDataModel,
  BaseTableReader,
  BaseTableWriter,
  BetterOmit,
  DataModelFromSchemaDefinition,
  DefineSchemaOptions,
  DocumentByInfo,
  DocumentByName,
  Expand,
  Expression,
  // Convex's name; core's `ExpressionOrValue` is the filter builder's runtime operand (STUDY-180).
  ExpressionOrValueOf as ExpressionOrValue,
  FieldPaths,
  FieldTypeFromFieldPath,
  FieldTypeFromFieldPathInner,
  FilterBuilder,
  GenericDatabaseReader,
  GenericDatabaseReaderWithTable,
  GenericDatabaseWriter,
  GenericDatabaseWriterWithTable,
  GenericDataModel,
  GenericDocument,
  GenericFieldPaths,
  GenericIndexFields,
  GenericSchema,
  GenericSearchIndexConfig,
  GenericTableIndexes,
  GenericTableInfo,
  GenericTableSearchIndexes,
  GenericTableVectorIndexes,
  GenericVectorIndexConfig,
  IdField,
  Indexes,
  IndexNames,
  IndexRange,
  IndexRangeBuilder,
  IndexTiebreakerField,
  NamedIndex,
  NamedSearchIndex,
  NamedTableInfo,
  NamedVectorIndex,
  OrderedQuery,
  PaginationResultOf as PaginationResult,
  Query,
  QueryInitializer,
  SchemaDefinition,
  SearchFilterBuilder,
  SearchFilterFinalizer,
  SearchIndexConfig,
  SearchIndexNames,
  SystemDataModel,
  SystemFields,
  SystemIndexes,
  SystemTableNames,
  // Convex exports the class as a type only.
  TableDefinition,
  TableNamesInDataModel,
  // Convex's names; in core `SearchIndexes` / `VectorIndexes` are the runtime's index sets (STUDY-180).
  TableSearchIndexes as SearchIndexes,
  TableVectorIndexes as VectorIndexes,
  VectorIndexConfig,
  VectorIndexNames,
  WithOptionalSystemFields,
  WithoutSystemFields,
} from "@bunvex/core";
export {
  type DocValidator,
  defineSchema,
  defineTable,
  docValidator,
  type SchemaValidators,
  SearchFilter,
  type SystemFieldValidators,
} from "@bunvex/core";
// Function references, as Convex's `convex/server` exports them (STUDY-26 C3).
export {
  type AnyApi,
  anyApi,
  type DefaultFunctionArgs,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  type FunctionType,
  type FunctionVisibility,
  getFunctionAddress,
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
  FunctionReference_future,
  FunctionReferenceFromExport,
  PartialApi,
} from "./api-types.ts";
export { filterApi } from "./api-types.ts";
export { LINKED_MODULES } from "./code-version.ts";
// Components' definitions (STUDY-153 PR 1): `bunvex.config.ts`'s `defineApp` / `defineComponent` and `components`.
export {
  type AnyChildComponents,
  type AnyComponentReference,
  type AnyComponents,
  type AppDefinition,
  type AppDefinitionAnalysis,
  type ComponentDefinition,
  type ComponentDefinitionAnalysis,
  componentsGeneric,
  currentSystemUdfInComponent,
  defineApp,
  defineComponent,
  type EnvDefinition,
  type EnvFromAppDefinition,
  type EnvFromDefinition,
  type EnvRef,
  type InstalledComponent,
} from "./components.ts";
export { type CronJob, Crons, cronJobs, type DayOfWeek, type Schedule } from "./cron.ts";
// Function handles (STUDY-50), as Convex's `createFunctionHandle` / `FunctionHandle`.
// `componentFunctionName`: a component's function by name, as `@bunvex/testing` calls one (STUDY-159).
export { componentFunctionName, createFunctionHandle, type FunctionHandle } from "./function-handles.ts";
// Who calls, as `@bunvex/testing` calls a function as a user (STUDY-159).
export {
  type ActionCtx,
  type ArgsOf,
  type ArgsValidator,
  type Auth,
  action,
  actionGeneric,
  callerOf,
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
  type StorageActionWriter,
  type StorageReader,
  type StorageWriter,
} from "./functions.ts";
export {
  instanceSecretError,
  LOCAL_BACKEND_USAGE,
  type LocalBackendFlags,
  type LocalBackendIo,
  localBackendMain,
  parseLocalBackendFlags,
  type RunningLocalBackend,
  startLocalBackend,
} from "./local-backend.ts";
export {
  type AuditLogBody,
  AuditLogLimitError,
  type AuditLogValue,
  type LogVar,
  log,
} from "./log.ts";
export type {
  ActionMeta,
  DeploymentMetadata,
  FunctionMetadata,
  MutationMeta,
  QueryMeta,
  RequestMetadata,
  TransactionMetric,
  TransactionMetrics,
} from "./meta.ts";
export {
  type Cursor,
  type PaginationOptions,
  paginationOptsValidator,
  paginationResultValidator,
} from "./pagination.ts";
export { openPersistence, type PersistenceConfig, persistenceConfigFromEnv } from "./persistence.ts";
// The analysis a push of components gets, without a deployment: the CLI's codegen (STUDY-156, DV-532).
export { componentAnalysis, PushError } from "./push.ts";
export type {
  ActionBuilder,
  AdvancedRunQueryOptions,
  ArgsAndOptions,
  ArgsArray,
  ArgsArrayForOptionalValidator,
  ArgsArrayToObject,
  DefaultArgsForOptionalValidator,
  FilterExpression,
  GenericActionCtx,
  GenericMutationCtx,
  GenericMutationCtxWithTable,
  GenericQueryCtx,
  GenericQueryCtxWithTable,
  HttpActionBuilder,
  MutationBuilder,
  MutationBuilderWithTable,
  PresenceBuilder,
  QueryBuilder,
  QueryBuilderWithTable,
  RegisteredAction,
  RegisteredMutation,
  RegisteredPresence,
  RegisteredQuery,
  RegisteredRoom,
  ReturnValueForOptionalValidator,
  RoomBuilder,
  TransactionLimits,
  ValidatorTypeToReturnType,
  VectorFilterBuilder,
  VectorSearch,
  VectorSearchQuery,
} from "./registration.ts";
// Rooms and presence scopes (AD-42).
export {
  type AnyRoomDef,
  isRoomDef,
  type PresenceDef,
  presence,
  presenceGeneric,
  type RoomDef,
  type RoomGate,
  room,
  roomGeneric,
} from "./rooms/define.ts";
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
  type RouteSpecWithPath,
  type RouteSpecWithPathPrefix,
} from "./router.ts";
export {
  type SchedulableFunction,
  type SchedulableFunctionReference,
  ScheduledJobExecutor,
  type Scheduler,
  type SchedulerOptions,
} from "./scheduler.ts";
export { createServer, type ServerOptions } from "./server.ts";
// Hosted services (STUDY-151 §4), as Convex's `getServiceToken` / `getServiceUrl`: unavailable when self-hosted.
export { getServiceToken, getServiceUrl, type ServiceName } from "./service-tokens.ts";

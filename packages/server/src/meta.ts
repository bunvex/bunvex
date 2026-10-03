// `ctx.meta`'s types (STUDY-44), as Convex's npm-packages/convex/src/server/meta.ts. The runtime is
// `Functions.meta` in functions.ts.
import type { FunctionVisibility } from "@bunvex/protocol";

/** Used and remaining amounts for one transaction limit. */
export type TransactionMetric = { used: number; remaining: number };

/** The headroom a transaction has left before its limits. */
export type TransactionMetrics = {
  bytesRead: TransactionMetric;
  bytesWritten: TransactionMetric;
  databaseQueries: TransactionMetric;
  documentsRead: TransactionMetric;
  documentsWritten: TransactionMetric;
  functionsScheduled: TransactionMetric;
  scheduledFunctionArgsBytes: TransactionMetric;
  /** @internal */
  filesWritten: TransactionMetric;
  /** @internal */
  fileWriteBytes: TransactionMetric;
  /** @internal */
  filesRead: TransactionMetric;
  /** @internal */
  fileReadBytes: TransactionMetric;
};

/** The running function: `"path/to/module:functionName"`, its component (`""` for the app), kind, visibility. */
export type FunctionMetadata = {
  name: string;
  componentPath: string;
  type: "query" | "mutation" | "action";
  visibility: FunctionVisibility;
};

/** The deployment: its name; a self-hosted one has no region and the smallest class. */
export type DeploymentMetadata = { name: string; region: string | null; class: "s16" | "s256" | "d1024" | "d2048" };

/**
 * The request the execution comes from; nested calls share it. `ip` and `userAgent` are null without an HTTP
 * request (a scheduled function); `scheduledFunctionId` is the scheduled function this execution belongs to;
 * `authToken` the user's raw token (null for an admin key or none).
 */
export type RequestMetadata = {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  scheduledFunctionId: string | null;
  authToken: string | null;
};

export interface QueryMeta {
  getFunctionMetadata(): Promise<FunctionMetadata>;
  getTransactionMetrics(): Promise<TransactionMetrics>;
  getDeploymentMetadata(): Promise<DeploymentMetadata>;
  /** The snapshot's timestamp in nanoseconds; reading it makes a query time-dependent, as `Date.now()` does. */
  getSnapshotTs(): bigint;
}

export interface MutationMeta extends QueryMeta {
  getRequestMetadata(): Promise<RequestMetadata>;
}

export interface ActionMeta {
  getFunctionMetadata(): Promise<FunctionMetadata>;
  getDeploymentMetadata(): Promise<DeploymentMetadata>;
  getRequestMetadata(): Promise<RequestMetadata>;
}

// The Workflows extension's part of the dashboard contract (UI-01 §26.3, STUDY-12 §17) — a bunvex addition: the
// durable workflows and the work pools apps build with Convex's `@convex-dev/workflow` and `@convex-dev/workpool`
// components have no screen in Convex's dashboard. A workflow is a function whose steps (queries, mutations,
// actions, sleeps, waits for an event, nested workflows) are journaled: each runs once, failed ones retry by a
// policy, a run can be canceled, rerun, or restarted from a step. A work pool runs functions with a parallelism
// limit and retries with exponential backoff. Every method is optional (detected with `typeof`), gated on
// `viewData` (reads) and `writeData` (cancel, rerun, restart).
import type { CallOptions, Page, Value } from "../../data-source.ts";

export type RunStatus = "running" | "success" | "failed" | "canceled";
export const RUN_STATUSES: readonly RunStatus[] = ["running", "success", "failed", "canceled"];

export type StepKind = "query" | "mutation" | "action" | "sleep" | "event" | "workflow";
export type StepStatus = "pending" | "running" | "retrying" | "success" | "failed" | "canceled";

/** One step of a run, as journaled. */
export type WorkflowStep = {
  /** Its place in the journal (0-based). */
  index: number;
  kind: StepKind;
  /** The function it runs ("emails:send"), the event it waits for, or "sleep". */
  name: string;
  /** Steps started together (`Promise.all`) share a group; groups run in order. */
  group: number;
  status: StepStatus;
  startedAt: number | null;
  finishedAt: number | null;
  /** Tries so far, the first included. */
  attempts: number;
  args: Value;
  result?: Value;
  error?: string;
};

export type WorkflowRun = {
  id: string;
  /** The workflow's function, e.g. "onboarding:welcome". */
  workflow: string;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  /** The running step's name, while it runs. */
  currentStep: string | null;
  steps: number;
  /** Retries over all its steps. */
  retries: number;
  args: Value;
  result?: Value;
  error?: string;
};

export type WorkflowRunDetail = { run: WorkflowRun; journal: WorkflowStep[] };

export type WorkflowRunQuery = {
  cursor: string | null;
  numItems: number;
  status?: RunStatus;
  workflow?: string;
};

export type RetryPolicy = { maxAttempts: number; initialBackoffMs: number; base: number };

/** A work pool: what runs, what waits, what failed; and its throughput, per minute over the last 30. */
export type Workpool = {
  name: string;
  maxParallelism: number;
  running: number;
  pending: number;
  /** Waiting out a retry's backoff. */
  backingOff: number;
  /** Over the last 24 hours. */
  succeeded: number;
  failed: number;
  canceled: number;
  retry: RetryPolicy;
  retryByDefault: boolean;
  throughput: { time: number; completed: number; failed: number }[];
};

export interface WorkflowFeatures {
  /** Newest first. */
  listWorkflowRuns?(query: WorkflowRunQuery, opts?: CallOptions): Promise<Page<WorkflowRun>>;
  getWorkflowRun?(id: string, opts?: CallOptions): Promise<WorkflowRunDetail | null>;
  /** The workflow names with a run, for filtering. */
  listWorkflowNames?(opts?: CallOptions): Promise<string[]>;
  /** Stops a running run: the running step finishes or is canceled, no further step starts. */
  cancelWorkflowRun?(id: string, opts?: CallOptions): Promise<void>;
  /** Starts a new run with the same arguments; returns its id. */
  rerunWorkflow?(id: string, opts?: CallOptions): Promise<string>;
  /** Starts a new run that replays the journal before `stepIndex` and runs again from it; returns its id. */
  restartWorkflowFrom?(id: string, stepIndex: number, opts?: CallOptions): Promise<string>;
  listWorkpools?(opts?: CallOptions): Promise<Workpool[]>;
}

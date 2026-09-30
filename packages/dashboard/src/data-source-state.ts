// Pausing a deployment, in the dashboard contract (UI-01 §17.2, STUDY-12 §11), as Convex's
// `POST /api/pause_deployment` / `unpause_deployment` and its deployment state. Every method is optional: a
// source offers pausing by having them (detected with `typeof`). Re-exported by `data-source.ts`.
import type { CallOptions } from "./data-source.ts";

/**
 * Running, or paused: while paused, new function calls fail, scheduled runs wait until it resumes and
 * cron jobs are skipped (Convex's `PAUSE_EXPLANATION`).
 */
export type DeploymentState = { state: "running" | "paused" };

export interface DeploymentStateFeatures {
  getDeploymentState?(opts?: CallOptions): Promise<DeploymentState>;
  /** Needs the `pauseDeployment` operation. Pausing a paused deployment is not an error. */
  pauseDeployment?(opts?: CallOptions): Promise<void>;
  /** Needs the `resumeDeployment` operation. Resuming a running deployment is not an error. */
  resumeDeployment?(opts?: CallOptions): Promise<void>;
}

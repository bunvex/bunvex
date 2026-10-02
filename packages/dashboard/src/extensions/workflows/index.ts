// The Workflows extension (UI-01 §26.3, STUDY-12 §17 — a bunvex addition, owner's call 1 Oct 2026, possibly
// removed later): durable workflow runs (a journal of steps, drawn as a diagram and a timeline) and work pools.
import { Workflow } from "lucide-react";
import type { DashboardExtension } from "../types.ts";
import type { RunStatus } from "./data-source.ts";

export const WORKFLOW_SECTIONS = ["runs", "workpools"] as const;
export type WorkflowSection = (typeof WORKFLOW_SECTIONS)[number];

/** Runs: the open run, its selected step, and the list's filters. Every key, `undefined` when invalid. */
export type WorkflowSearch = { run?: string; step?: number; status?: RunStatus; workflow?: string };

export const validateWorkflowSearch = (input: Record<string, unknown>): WorkflowSearch => ({
  run: typeof input.run === "string" && /^[\w-]{1,64}$/.test(input.run) ? input.run : undefined,
  step: typeof input.step === "number" && Number.isInteger(input.step) && input.step >= 0 ? input.step : undefined,
  // the statuses inline: this module is in the shell's chunk (the registry), the contract module is not
  status: ["running", "success", "failed", "canceled"].includes(input.status as string)
    ? (input.status as RunStatus)
    : undefined,
  workflow: typeof input.workflow === "string" && /^[\w/:.-]{1,128}$/.test(input.workflow) ? input.workflow : undefined,
});

const load = () => import("./screen.tsx");

export const workflowsExtension: DashboardExtension = {
  id: "workflows",
  title: "Workflows",
  icon: Workflow,
  nav: { group: "functions", order: 10, to: "/workflows/runs" },
  routes: [
    { path: "workflows", load, component: "WorkflowsScreen" },
    { path: "workflows/$section", load, component: "WorkflowsScreen", validateSearch: validateWorkflowSearch },
  ],
  requires: ["listWorkflowRuns", "getWorkflowRun", "listWorkflowNames", "listWorkpools"],
};

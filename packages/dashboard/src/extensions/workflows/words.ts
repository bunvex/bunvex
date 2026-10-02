// Statuses and durations in words (UI-01 §26.3): every status is shown as an icon AND its word, never colour alone.
import { Ban, Check, Circle, Clock, LoaderCircle, RotateCw, X } from "lucide-react";
import type { RunStatus, StepKind, StepStatus } from "./data-source.ts";

export const STATUS: Record<StepStatus | RunStatus, { word: string; icon: typeof Check; tone: string }> = {
  success: { word: "Succeeded", icon: Check, tone: "text-success" },
  failed: { word: "Failed", icon: X, tone: "text-destructive" },
  running: { word: "Running", icon: LoaderCircle, tone: "text-info" },
  retrying: { word: "Retrying", icon: RotateCw, tone: "text-warning" },
  pending: { word: "Pending", icon: Circle, tone: "text-muted-foreground" },
  canceled: { word: "Canceled", icon: Ban, tone: "text-muted-foreground" },
};

export const KIND: Record<StepKind, string> = {
  query: "Query",
  mutation: "Mutation",
  action: "Action",
  sleep: "Sleep",
  event: "Waits for event",
  workflow: "Workflow",
};

export { Clock };

/** "40 ms", "3.2 s", "4 min 10 s", "3 d 2 h". */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min ${Math.round((ms % 60_000) / 1000)} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** A step's or run's elapsed time: until it finished, or until `now` while it runs. */
export const elapsed = (start: number | null, end: number | null, now: number) =>
  start === null ? null : (end ?? now) - start;

// The functions a request called, as a tree (STUDY-12 L6), built from the loaded lines as Convex's "Functions
// Called" outline is: one node per execution, under the execution that called it, in the order they
// started. An execution whose last line has not arrived is still running; one whose caller is not among the
// loaded lines stands at the top.
import type { FunctionKind, LogEntry } from "../data-source.ts";

export type CallNode = {
  executionId: string;
  function?: { path: string; kind: FunctionKind };
  /** The time of its first loaded line. */
  start: number;
  status: "success" | "failure" | "running";
  durationMs?: number;
  children: CallNode[];
};

/** The executions of one request's lines, as a forest (usually one tree). Lines without an execution id are left out. */
export function callTree(lines: LogEntry[]): CallNode[] {
  const nodes = new Map<string, CallNode & { parent?: string }>();
  for (const e of [...lines].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!e.executionId) continue;
    let n = nodes.get(e.executionId);
    if (!n) {
      n = { executionId: e.executionId, function: e.function, start: e.time, status: "running", children: [] };
      if (e.parentExecutionId) n.parent = e.parentExecutionId;
      nodes.set(e.executionId, n);
    }
    if (e.execution) {
      n.status = e.execution.status;
      n.durationMs = e.execution.durationMs;
    }
  }
  // nodes were made in the order their first lines came, so every list below is already in starting order
  const roots: CallNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parent ? nodes.get(n.parent) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  // callers are kept internal: a node's place in the tree says it
  const clean = (n: CallNode & { parent?: string }): CallNode => {
    const { parent: _, ...rest } = n;
    return { ...rest, children: rest.children.map(clean) };
  };
  return roots.map(clean);
}

/** How many executions a forest holds. */
export const countCalls = (forest: CallNode[]): number => forest.reduce((n, c) => n + 1 + countCalls(c.children), 0);

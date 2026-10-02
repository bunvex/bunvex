// The contract suite's part for the Workflows extension (UI-01 §26.3): runs newest first and filterable, a
// run's journal in index order with each step's group never going backwards, statuses that agree (a finished
// run has no running step), work pools within their parallelism; with writes on, cancel / rerun / restart.
import { expect } from "bun:test";
import type { ContractContext, ContractExtensionPart } from "../contract-types.ts";
import { offers } from "../types.ts";
import type { WorkflowRunDetail } from "./data-source.ts";
import { workflowsExtension } from "./index.ts";

export function expectRun({ run, journal }: WorkflowRunDetail) {
  expect(journal.map((s) => s.index)).toEqual(journal.map((_, i) => i));
  expect(journal.every((s, i) => i === 0 || s.group >= journal[i - 1]!.group)).toBe(true);
  expect(journal.every((s) => s.attempts >= (s.status === "pending" ? 0 : 1))).toBe(true);
  if (run.status !== "running")
    expect(journal.some((s) => s.status === "running" || s.status === "retrying")).toBe(false);
  if (run.status === "success") expect(journal.every((s) => s.status === "success")).toBe(true);
  expect(run.steps).toBe(journal.length);
}

function describeWorkflowsContract({ make, test, writes }: ContractContext) {
  const offered = async () => {
    const src = await make();
    return offers(src, workflowsExtension) ? src : null;
  };

  test("workflows (when offered): runs newest first, filterable; each run's journal consistent", async () => {
    const src = await offered();
    if (!src) return;
    const page = await src.listWorkflowRuns!({ cursor: null, numItems: 50 });
    expect(page.page.every((r, i) => i === 0 || r.startedAt <= page.page[i - 1]!.startedAt)).toBe(true);
    for (const r of page.page.slice(0, 8)) {
      const d = await src.getWorkflowRun!(r.id);
      expect(d?.run.id).toBe(r.id);
      expectRun(d!);
    }
    const failed = await src.listWorkflowRuns!({ cursor: null, numItems: 50, status: "failed" });
    expect(failed.page.every((r) => r.status === "failed" && r.error)).toBe(true);
    const name = (await src.listWorkflowNames!())[0];
    if (name) {
      const named = await src.listWorkflowRuns!({ cursor: null, numItems: 50, workflow: name });
      expect(named.page.every((r) => r.workflow === name)).toBe(true);
    }
    expect(await src.getWorkflowRun!("wf_nonexistent")).toBeNull();
  });

  test("workpools (when offered): within their parallelism, 30 throughput minutes", async () => {
    const src = await offered();
    if (!src) return;
    for (const p of await src.listWorkpools!()) {
      expect(p.running <= p.maxParallelism && p.maxParallelism >= 1).toBe(true);
      expect(p.throughput).toHaveLength(30);
      expect(p.retry.maxAttempts >= 1 && p.retry.base >= 1).toBe(true);
    }
  });

  test("workflows (writes): cancel a running run; rerun and restart start new runs", async () => {
    if (!writes) return;
    const src = await offered();
    if (!src?.cancelWorkflowRun || !src.rerunWorkflow || !src.restartWorkflowFrom) return;
    const running = (await src.listWorkflowRuns!({ cursor: null, numItems: 50, status: "running" })).page[0];
    if (!running) return;
    await src.cancelWorkflowRun(running.id);
    const canceled = await src.getWorkflowRun!(running.id);
    expect(canceled!.run.status).toBe("canceled");
    expectRun(canceled!);
    const again = await src.rerunWorkflow(running.id);
    expect((await src.getWorkflowRun!(again))!.run.workflow).toBe(running.workflow);
    const from = await src.restartWorkflowFrom(running.id, 1);
    const restarted = await src.getWorkflowRun!(from);
    expect(restarted!.journal[0]).toEqual(canceled!.journal[0]);
  });
}

export const workflowsContract: ContractExtensionPart = {
  id: "workflows",
  requires: workflowsExtension.requires,
  describe: describeWorkflowsContract,
};

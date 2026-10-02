// The Workflows extension's part of the mock (UI-01 §26): the MockWorkflows simulation behind the optional
// methods, with the mock's latency/failures, credentials and audit log (cancel, rerun and restart are recorded).
import { DataSourceError } from "../../data-source.ts";
import { createRandom } from "../../mock/random.ts";
import type { MockExtensionPart } from "../mock-types.ts";
import type { WorkflowRunQuery } from "./data-source.ts";
import { MockWorkflows } from "./mock.ts";

type Opts = { signal?: AbortSignal };

export const workflowsMock: MockExtensionPart = {
  id: "workflows",
  create: (ctx) => {
    const seed = typeof ctx.options.seed === "number" ? ctx.options.seed : 1;
    const sim = new MockWorkflows(createRandom(seed + 29), ctx.now);
    const read = () => {
      if (!ctx.can("viewData")) throw new DataSourceError("unauthorized", "this credential cannot view workflows");
    };
    const write = () => {
      if (!ctx.can("write")) throw new DataSourceError("unauthorized", "this credential cannot change workflows");
    };
    const refuse = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        if (e instanceof DataSourceError) throw e;
        throw new DataSourceError("invalid_request", (e as Error).message);
      }
    };
    return {
      listWorkflowRuns: (q: WorkflowRunQuery, o?: Opts) => ctx.call(o?.signal, () => (read(), sim.list(q))),
      getWorkflowRun: (id: string, o?: Opts) => ctx.call(o?.signal, () => (read(), sim.get(id))),
      listWorkflowNames: (o?: Opts) => ctx.call(o?.signal, () => (read(), sim.names())),
      listWorkpools: (o?: Opts) => ctx.call(o?.signal, () => (read(), sim.pools())),
      cancelWorkflowRun: (id: string, o?: Opts) =>
        ctx.call(o?.signal, () => {
          write();
          refuse(() => sim.cancel(id));
          ctx.record("cancel_workflow", { id });
        }),
      rerunWorkflow: (id: string, o?: Opts) =>
        ctx.call(o?.signal, () => {
          write();
          let next = "";
          refuse(() => {
            next = sim.rerun(id);
          });
          ctx.record("rerun_workflow", { id, run: next });
          return next;
        }),
      restartWorkflowFrom: (id: string, stepIndex: number, o?: Opts) =>
        ctx.call(o?.signal, () => {
          write();
          let next = "";
          refuse(() => {
            next = sim.restartFrom(id, stepIndex);
          });
          ctx.record("restart_workflow", { id, step: stepIndex, run: next });
          return next;
        }),
    };
  },
};

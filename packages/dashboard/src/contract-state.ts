// The contract suite's part for pausing (UI-01 §17.2, data-source-state.ts). Reading the state is checked
// whenever the source offers it; pausing and resuming only when the caller opts in — never on a deployment
// that serves anyone.
import { expect } from "bun:test";
import type { DashboardDataSource } from "./data-source.ts";

export type DeploymentStateContractOptions = {
  /**
   * Lets the suite pause the deployment and resume it (it ends running). With `query`, it also checks that a
   * paused deployment refuses to run that query.
   */
  pause?: { toggle: boolean; query?: string };
};

type Ctx = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
  opts: DeploymentStateContractOptions;
};

export function describeDeploymentStateContract({ make, test, opts }: Ctx) {
  test("deployment state (when offered): running or paused", async () => {
    const src = await make();
    if (!src.getDeploymentState) return;
    expect(["running", "paused"]).toContain((await src.getDeploymentState()).state);
  });

  if (opts.pause?.toggle)
    test("pause and resume (opt-in): the state follows; both are idempotent; paused refuses new calls", async () => {
      const src = await make();
      if (!src.getDeploymentState || !src.pauseDeployment || !src.resumeDeployment) return;
      try {
        await src.pauseDeployment();
        await src.pauseDeployment();
        expect((await src.getDeploymentState()).state).toBe("paused");
        const query = opts.pause?.query;
        if (query && src.runFunction) {
          let refused = false;
          await src.runFunction(query, {}).catch(() => {
            refused = true;
          });
          expect(refused).toBe(true);
        }
      } finally {
        await src.resumeDeployment();
      }
      await src.resumeDeployment();
      expect((await src.getDeploymentState()).state).toBe("running");
    });
}

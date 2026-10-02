// The contract suite's part for who the clients are (UI-01 §33, data-source-clients.ts). The reads run whenever
// the source offers them and the credential may see metrics: a summary that adds up, SDK states that follow
// its own policy, and topology buckets that add up to each node's connections. The registry's writes run only
// when the suite is given `writes` (they change what the deployment says about its apps).
import { expect } from "bun:test";
import type { DashboardDataSource } from "./data-source.ts";
import { CLIENT_PLATFORMS, sdkState } from "./data-source-clients.ts";

type Ctx = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
  writes: boolean;
};

const canSee = async (src: DashboardDataSource) => (await src.getCapabilities()).operations.includes("viewMetrics");

export function describeClientsContract({ make, test, writes }: Ctx) {
  test("clients (when offered): the summary adds up, and each SDK's state follows the policy", async () => {
    const src = await make();
    if (!src.getClientSummary || !(await canSee(src))) return;
    const s = await src.getClientSummary();
    expect(s.byPlatform.reduce((a, p) => a + p.connections, 0)).toBe(s.connections);
    expect(s.sdkVersions.reduce((a, v) => a + v.connections, 0)).toBe(s.connections);
    for (const p of s.byPlatform) expect(CLIENT_PLATFORMS).toContain(p.platform);
    for (const v of s.sdkVersions) expect(v.state).toBe(sdkState(v.platform, v.version, s.policy));
    expect(s.byPlatform.every((p, i) => i === 0 || p.connections <= s.byPlatform[i - 1]!.connections)).toBe(true);
  });

  test("clients (when offered): a node's client buckets add up to its connections", async () => {
    const src = await make();
    if (!src.getTopology || !(await canSee(src))) return;
    for (const n of (await src.getTopology()).nodes)
      if (n.clients) expect(n.clients.reduce((a, b) => a + b.connections, 0)).toBe(n.connections);
  });

  if (writes)
    test("clients (when offered): register an app, rename it, remove it", async () => {
      const src = await make();
      if (!src.createClientApp || !src.listClientApps || !src.updateClientApp || !src.deleteClientApp) return;
      const made = await src.createClientApp({
        name: "Contract app",
        platform: "web",
        identifiers: ["https://contract.test"],
      });
      expect((await src.listClientApps()).some((a) => a.id === made.id && a.name === "Contract app")).toBe(true);
      const renamed = await src.updateClientApp(made.id, { name: "Contract app 2" });
      expect(renamed.name).toBe("Contract app 2");
      await src.deleteClientApp(made.id);
      expect((await src.listClientApps()).some((a) => a.id === made.id)).toBe(false);
    });
}

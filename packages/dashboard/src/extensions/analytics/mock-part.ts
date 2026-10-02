// The Analytics extension's part of the mock (UI-01 §26): the MockAnalytics simulation behind the contract's
// optional methods, with the mock's latency/failures and credentials. Its own knob: `analyticsIntervalMs`
// (how often the watch delivers; default 2 000 ms).
import { DataSourceError, toDataSourceError } from "../../data-source.ts";
import { createRandom } from "../../mock/random.ts";
import type { MockExtensionPart } from "../mock-types.ts";
import type { AnalyticsQuery, AnalyticsRealtime } from "./data-source.ts";
import { MockAnalytics } from "./mock.ts";

export const analyticsMock: MockExtensionPart = {
  id: "analytics",
  create: (ctx) => {
    const seed = typeof ctx.options.seed === "number" ? ctx.options.seed : 1;
    const sim = new MockAnalytics(createRandom(seed + 17), ctx.now());
    const every = typeof ctx.options.analyticsIntervalMs === "number" ? ctx.options.analyticsIntervalMs : 2000;
    const allowed = () => {
      if (!ctx.can("viewMetrics")) throw new DataSourceError("unauthorized", "this credential cannot view analytics");
    };
    return {
      getAnalyticsRealtime: (opts?: { signal?: AbortSignal }) =>
        ctx.call(opts?.signal, () => (allowed(), sim.realtime())),
      watchAnalyticsRealtime: (onRealtime: (r: AnalyticsRealtime) => void, onError: (e: DataSourceError) => void) => {
        let live = true;
        const deliver = () => {
          if (!live) return;
          try {
            allowed();
            onRealtime(sim.realtime());
          } catch (e) {
            onError(toDataSourceError(e));
          }
        };
        const first = setTimeout(deliver, 0);
        const timer = setInterval(() => {
          sim.step(every);
          deliver();
        }, every);
        return () => {
          live = false;
          clearTimeout(first);
          clearInterval(timer);
        };
      },
      listAnalyticsEvents: (q: AnalyticsQuery, opts?: { signal?: AbortSignal }) =>
        ctx.call(opts?.signal, () => (allowed(), sim.listEvents(q))),
      listAnalyticsSessions: (q: AnalyticsQuery, opts?: { signal?: AbortSignal }) =>
        ctx.call(opts?.signal, () => (allowed(), sim.listSessions(q))),
      listAnalyticsProfiles: (q: AnalyticsQuery, opts?: { signal?: AbortSignal }) =>
        ctx.call(opts?.signal, () => (allowed(), sim.listProfiles(q))),
    };
  },
};

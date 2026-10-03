// Faults to inject during a run (STUDY-57 §4). "none" is a run without faults; the others put a TCP proxy
// between the clients and the server (proxy.ts) and, every few hundred milliseconds, inject one fault:
//   partition  cut every client connection, or refuse new ones for a while
//   kill       SIGKILL the server and start it again on the same data
//   skew       the same, the new process's clock up to 2 s ahead of or behind the real one
//   store      the store is slow, fails reads, fails flushes (retried; or for good: the process exits)
//   all        any of the above but skew (see NEMESES)
import { TcpProxy } from "./proxy.ts";
import type { Rng } from "./rng.ts";
import type { Nemesis, NemesisContext } from "./runner.ts";

type Fault = "partition" | "kill" | "skew";

function faults(name: string, kinds: Fault[], store: boolean): Nemesis {
  let proxy: TcpProxy | null = null;
  let restarts = 0;
  const restart = async (ctx: NemesisContext, env?: Record<string, string>) => {
    const port = await ctx.server.start(store ? { JEPSEN_STORE_FAULTS: String(ctx.seed + ++restarts), ...env } : env);
    proxy!.upstreamPort = port;
  };
  return {
    name,
    serverEnv: (seed): Record<string, string> => (store ? { JEPSEN_STORE_FAULTS: String(seed) } : {}),
    expected: store ? (error) => /injected store fault/.test(error) : undefined,
    setup(ctx) {
      proxy = new TcpProxy(ctx.server.port);
      return `http://127.0.0.1:${proxy.listen()}`;
    },
    async act(ctx, r: Rng) {
      await Bun.sleep(150 + r.int(450));
      // a store fault the committer cannot retry ends the process (fail-stop): bring it back, as a supervisor
      if (!ctx.server.alive) {
        ctx.events.push(`${ctx.now().toFixed(0)} server exited: restart`);
        await restart(ctx);
      }
      if (!kinds.length) return;
      const kind = r.pick(kinds);
      if (kind === "partition") {
        if (r.chance(0.5)) {
          ctx.events.push(`${ctx.now().toFixed(0)} cut ${proxy!.dropAll()} connections`);
        } else {
          const ms = 100 + r.int(500);
          ctx.events.push(`${ctx.now().toFixed(0)} partition for ${ms} ms`);
          proxy!.blocked = true;
          proxy!.dropAll();
          await Bun.sleep(ms);
          proxy!.blocked = false;
        }
      } else {
        const skew = kind === "skew" ? r.int(4001) - 2000 : 0;
        await ctx.server.kill();
        ctx.events.push(`${ctx.now().toFixed(0)} SIGKILL${skew ? `, restart with the clock ${skew} ms off` : ""}`);
        await Bun.sleep(r.int(200));
        await restart(ctx, skew ? { JEPSEN_CLOCK_SKEW_MS: String(skew) } : undefined);
      }
    },
    async heal(ctx) {
      proxy!.blocked = false;
      // the final reads need a store without faults: restart the server on a sound one (a subscription that
      // got an injected store error keeps it until its data changes — DV-80 — and a reconnect re-runs it)
      if (store) {
        await ctx.server.kill();
        proxy!.upstreamPort = await ctx.server.start({ JEPSEN_STORE_FAULTS: "" });
        proxy!.dropAll();
      } else if (!ctx.server.alive) await restart(ctx);
    },
    teardown() {
      proxy?.close();
    },
  };
}

export const NEMESES: Record<string, () => Nemesis | undefined> = {
  none: () => undefined,
  partition: () => faults("partition", ["partition"], false),
  kill: () => faults("kill", ["kill"], false),
  skew: () => faults("skew", ["skew"], false),
  store: () => faults("store", [], true),
  // not "skew" yet: a restart with the clock behind breaks the _creationTime order (test/regressions.test.ts)
  all: () => faults("all", ["partition", "kill"], true),
};

export function nemesisByName(name: string): Nemesis | undefined {
  const make = NEMESES[name];
  if (!make) throw new Error(`unknown nemesis "${name}" (known: ${Object.keys(NEMESES).join(", ")})`);
  return make();
}

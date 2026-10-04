// Faults to inject during a run (STUDY-57 §4). "none" is a run without faults; the others put a TCP proxy
// between the clients and the server (proxy.ts) and, every few hundred milliseconds, inject one fault:
//   partition  cut every client connection, or refuse new ones for a while
//   kill       SIGKILL the server and start it again on the same data
//   skew       the same, the new process's clock up to 2 s ahead of or behind the real one
//   store      the store is slow, fails reads, fails flushes (retried; or for good: the process exits)
//   all        any of the above but skew (see NEMESES); on a remote store, its connections are cut too (a
//              second proxy, in front of the database)
import { TcpProxy } from "./proxy.ts";
import type { Rng } from "./rng.ts";
import type { Nemesis, NemesisContext } from "./runner.ts";

type Fault = "partition" | "kill" | "skew" | "db";

const DEFAULT_PORTS: Record<string, number> = {
  "postgres:": 5432,
  "postgresql:": 5432,
  "mysql:": 3306,
  "mongodb:": 27017,
};

function faults(name: string, kinds: Fault[], store: boolean): Nemesis {
  let proxy: TcpProxy | null = null;
  let db: TcpProxy | null = null;
  let restarts = 0;
  const restart = async (ctx: NemesisContext, env?: Record<string, string>) => {
    const port = await ctx.server.start(store ? { JEPSEN_STORE_FAULTS: String(ctx.seed + ++restarts), ...env } : env);
    proxy!.upstreamPort = port;
  };
  // a store fault the committer cannot retry ends the process (fail-stop), and so can one while it starts (a
  // read of the crons' push): bring it back, as a supervisor
  const recover = async (ctx: NemesisContext) => {
    if (ctx.server.alive) return;
    ctx.events.push(`${ctx.now().toFixed(0)} server exited: restart`);
    await restart(ctx);
  };
  return {
    name,
    serverEnv(seed, env) {
      const out: Record<string, string> = store ? { JEPSEN_STORE_FAULTS: String(seed) } : {};
      // a remote store: its connections go through a proxy too, which "db" faults cut
      const url = env.PERSISTENCE_URL;
      if (store && url && env.PERSISTENCE && !["memory", "sqlite"].includes(env.PERSISTENCE)) {
        const u = new URL(url);
        db = new TcpProxy(Number(u.port || DEFAULT_PORTS[u.protocol]), u.hostname);
        u.hostname = "127.0.0.1";
        u.port = String(db.listen());
        // MongoDB would find the replica set's members by their own addresses, around the proxy
        if (u.protocol === "mongodb:") {
          u.searchParams.delete("replicaSet");
          u.searchParams.set("directConnection", "true");
        }
        out.PERSISTENCE_URL = u.toString();
      }
      return out;
    },
    // injected store errors, and (a remote store's connections cut) lost-connection errors: a function sees
    // them as its own error today (DV-80; Convex closes the client's connection and it retries)
    expected: store
      ? (error) =>
          /injected store fault/.test(error) ||
          (db !== null && /ECONNRESET|ECONNREFUSED|EPIPE|connection|terminated|timed? ?out|closed/i.test(error))
      : undefined,
    setup(ctx) {
      proxy = new TcpProxy(ctx.server.port);
      return `http://127.0.0.1:${proxy.listen()}`;
    },
    recover,
    async act(ctx, r: Rng) {
      await Bun.sleep(150 + r.int(450));
      await recover(ctx);
      const all: Fault[] = db ? [...kinds, "db"] : kinds;
      if (!all.length) return;
      const kind = r.pick(all);
      if (kind === "db") {
        if (r.chance(0.5)) {
          ctx.events.push(`${ctx.now().toFixed(0)} cut ${db!.dropAll()} store connections`);
        } else {
          const ms = 100 + r.int(500);
          ctx.events.push(`${ctx.now().toFixed(0)} store unreachable for ${ms} ms`);
          db!.blocked = true;
          db!.dropAll();
          await Bun.sleep(ms);
          db!.blocked = false;
        }
      } else if (kind === "partition") {
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
      if (db) db.blocked = false;
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
      db?.close();
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

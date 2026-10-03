// One run (STUDY-57 §3): start the server, let N clients run a seeded random workload for a while (with a
// nemesis injecting faults, when given), quiesce, read the final state, check the history.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunvexClient } from "@bunvex/client";
import { expectedFailure, History, type Op } from "./history.ts";
import { checkBank, checkLog, checkSet } from "./invariants.ts";
import { checkRegisters, type LinearizabilityResult } from "./linearizability.ts";
import { type ServerOptions, ServerProcess } from "./process.ts";
import { type Rng, rng } from "./rng.ts";

export type RunOptions = {
  seed: number;
  store: ServerOptions["store"];
  env?: ServerOptions["env"];
  clients?: number;
  durationMs?: number;
  /** Faults to inject while the workload runs. */
  nemesis?: Nemesis;
};

/** Something that injects faults during a run, and undoes them before the run quiesces. */
export type Nemesis = {
  name: string;
  /** Environment for the server process, from the run's seed (e.g. store faults). */
  serverEnv?(seed: number): Record<string, string>;
  /** A failure this nemesis causes on purpose (an injected store error), not a finding. */
  expected?(error: string): boolean;
  /** Called once the server is up; returns the URL clients should use (a proxy, for network faults). */
  setup?(ctx: NemesisContext): Promise<string | undefined> | string | undefined;
  /** Called repeatedly while the workload runs. */
  act(ctx: NemesisContext, r: Rng): Promise<void>;
  /** Heal everything (reconnect, restart) so the run can quiesce. */
  heal(ctx: NemesisContext): Promise<void>;
  teardown?(): Promise<void> | void;
};
export type NemesisContext = { seed: number; server: ServerProcess; events: string[]; now: () => number };

export type RunResult = {
  ok: boolean;
  seed: number;
  store: string;
  nemesis: string;
  durationMs: number;
  stats: { ops: number; ok: number; fail: number; info: number; byFunction: Record<string, number> };
  violations: string[];
  linearizability: LinearizabilityResult;
  /** The nemesis' actions, in order, with their times. */
  events: string[];
  history: Op[];
  serverOutput: string[];
};

const KEYS = ["r0", "r1", "r2", "r3"];
const READS = new Set(["reg:read", "bank:all", "set:all", "log:all"]);
const ACCOUNTS = ["a0", "a1", "a2", "a3", "a4"];
const EACH = 100;
const TOTAL = EACH * ACCOUNTS.length;

export async function run(opts: RunOptions): Promise<RunResult> {
  const r = rng(opts.seed);
  const nClients = opts.clients ?? 5;
  const duration = opts.durationMs ?? 2000;
  const dataDir = mkdtempSync(join(tmpdir(), "bunvex-jepsen-"));
  const server = new ServerProcess({
    store: opts.store,
    dataDir,
    env: { ...opts.env, ...opts.nemesis?.serverEnv?.(opts.seed) },
  });
  const history = new History();
  const violations: string[] = [];
  const events: string[] = [];
  const clients: BunvexClient[] = [];
  const t0 = performance.now();
  // a query error raised by a client with no one to catch it (it does so on purpose: "make some noise") must
  // not end the run: it is a finding
  const onUnhandled = (e: unknown) =>
    violations.push(`unhandled: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
  process.on("unhandledRejection", onUnhandled);
  try {
    const port = await server.start();
    const ctx: NemesisContext = { seed: opts.seed, server, events, now: () => history.now() };
    const url = (await opts.nemesis?.setup?.(ctx)) ?? `http://127.0.0.1:${port}`;
    const open = () =>
      new BunvexClient(url, { logger: false, webSocket: { defaultInitialBackoffMs: 20, maxBackoffMs: 200 } });

    // the starting state, once
    const admin = open();
    clients.push(admin);
    await admin.mutation("bank:init", { names: ACCOUNTS, each: EACH });

    const deadline = performance.now() + duration;
    const workers: Promise<void>[] = [];
    for (let c = 0; c < nClients; c++) {
      const client = open();
      clients.push(client);
      workers.push(worker(c, client, rng(opts.seed * 1000 + c), history, deadline, violations, opts.nemesis?.expected));
    }
    let nemesisDone: Promise<void> = Promise.resolve();
    if (opts.nemesis) {
      const nemesis = opts.nemesis;
      nemesisDone = (async () => {
        while (performance.now() < deadline - 200) await nemesis.act(ctx, r);
        await nemesis.heal(ctx);
      })();
    }
    await nemesisDone;
    // quiesce: every operation still in flight gets a bounded while to finish (resends after a reconnect)
    await Promise.race([Promise.all(workers), Bun.sleep(15_000)]);

    // the final state, from a fresh client on the server itself (where it runs now: a restart moves it)
    const reader = new BunvexClient(`http://127.0.0.1:${server.port}`, { logger: false });
    clients.push(reader);
    const nonce = 1e9;
    // a final read that fails is itself a finding (e.g. a register stored twice), not the end of the check
    const final = async <T>(name: string, args: Record<string, unknown>, fallback: T): Promise<T> => {
      try {
        return (await reader.query(name, { ...args, nonce })) as T;
      } catch (e) {
        violations.push(
          `final: ${name} ${JSON.stringify(args)} failed: ${(e instanceof Error ? e.message : String(e)).split("\n").slice(0, 2).join(" ")}`,
        );
        return fallback;
      }
    };
    const finalBank = await final<Record<string, number>>("bank:all", {}, {});
    const finalSet = await final<string[]>("set:all", {}, []);
    const finalLog = await final<[number, number][]>("log:all", {}, []);
    for (const key of KEYS) await final("reg:read", { key }, null);

    // convergence: every client's live subscriptions reach the final state
    await converge(clients.slice(1, 1 + nClients), finalBank, violations);

    // a mutation that failed on an injected store error may still take effect: its first attempt can be
    // running when the connection drops, and the resend's failure is what the client is told (DV-80; the
    // known bug in test/regressions.test.ts) — so such a failure is indeterminate, not "did not happen"
    for (const op of history.ops)
      if (op.status === "fail" && !READS.has(op.f) && opts.nemesis?.expected?.(op.error ?? "")) {
        op.status = "info";
        op.end = Infinity;
      }
    // a failure other than a lost OCC race (which the client is told about, and retries are bounded) or an
    // indeterminate one is a bug: a function that cannot fail on correct data failed
    for (const op of history.ops)
      if (op.status === "fail" && !expectedFailure(op.error ?? "") && !opts.nemesis?.expected?.(op.error ?? ""))
        violations.push(`error: client ${op.client}'s ${op.f} failed: ${(op.error ?? "").split("\n")[0]}`);
    violations.push(...checkBank(history.ops, TOTAL, finalBank));
    violations.push(...checkSet(history.ops, finalSet));
    violations.push(...checkLog(history.ops, finalLog));
    const linearizability = checkRegisters(history.ops);
    if (!linearizability.ok)
      violations.push(
        `registers: key ${linearizability.key} is not linearizable (${linearizability.minimal.length} ops)`,
      );

    // one sentence per kind of finding and client, with a count, rather than thousands of the same
    const summary = summarize(violations);
    violations.length = 0;
    violations.push(...summary);
    const stats = { ops: 0, ok: 0, fail: 0, info: 0, byFunction: {} as Record<string, number> };
    for (const op of history.ops) {
      stats.ops++;
      stats[op.status]++;
      stats.byFunction[op.f] = (stats.byFunction[op.f] ?? 0) + 1;
    }
    return {
      ok: violations.length === 0,
      seed: opts.seed,
      store: opts.store,
      nemesis: opts.nemesis?.name ?? "none",
      durationMs: Math.round(performance.now() - t0),
      stats,
      violations,
      linearizability,
      events,
      history: history.ops,
      serverOutput: server.output,
    };
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await opts.nemesis?.teardown?.();
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** One client: a single operation at a time (a Jepsen process), plus bursts of pipelined mutations. */
async function worker(
  c: number,
  client: BunvexClient,
  r: Rng,
  h: History,
  deadline: number,
  violations: string[],
  expected: (error: string) => boolean = () => false,
) {
  const own = `own${c}`;
  let next = 0;
  const value = () => c * 1_000_000 + ++next;
  let seq = 0;
  let tokens = 0;

  // live subscriptions: this client's own register (read-your-writes) and each balance on its own, which
  // must always sum to the total — one transition moves every query to the same snapshot (STUDY-23)
  const failed = (what: string) => (e: Error) => {
    if (!expected(e.message)) violations.push(`subscription: client ${c}'s ${what} failed: ${e.message}`);
  };
  const unsub: (() => void)[] = [client.onUpdate("reg:read", { key: own }, () => {}, failed(`reg:read ${own}`))];
  for (const name of ACCOUNTS)
    unsub.push(client.onUpdate("bank:balance", { name }, () => {}, failed(`bank:balance ${name}`)));
  const offTransition = client.client.addOnTransitionHandler(() => {
    let sum = 0;
    for (const name of ACCOUNTS) {
      const b = local(client, "bank:balance", { name });
      if (typeof b !== "number") return; // not all loaded yet (or failed: reported by the subscription)
      sum += b;
    }
    if (sum !== TOTAL)
      violations.push(`snapshot: client ${c}'s balance subscriptions summed to ${sum} after one transition`);
  });

  while (performance.now() < deadline) {
    const x = r.next();
    if (x < 0.3) {
      const key = r.pick(KEYS);
      await h.invoke(c, "reg:read", { key }, () => client.query("reg:read", { key, nonce: value() }));
    } else if (x < 0.5) {
      const key = r.pick(KEYS);
      const v = value();
      await h.invoke(c, "reg:write", { key, value: v }, () => client.mutation("reg:write", { key, value: v }));
    } else if (x < 0.62) {
      const key = r.pick(KEYS);
      // compare against a recent value of this key, or null, so some succeed
      const seen = h.ops.filter((o) => o.f !== "reg:read" && (o.args as { key: string }).key === key).slice(-3);
      const from = seen.length
        ? ((seen[r.int(seen.length)]!.args as { value?: number; to?: number }).value ??
          (seen[r.int(seen.length)]!.args as { to?: number }).to ??
          null)
        : null;
      const to = value();
      await h.invoke(c, "reg:cas", { key, from, to }, () => client.mutation("reg:cas", { key, from, to }));
    } else if (x < 0.77) {
      const from = r.pick(ACCOUNTS);
      let to = r.pick(ACCOUNTS);
      if (to === from) to = ACCOUNTS[(ACCOUNTS.indexOf(from) + 1) % ACCOUNTS.length]!;
      const amount = 1 + r.int(30);
      await h.invoke(c, "bank:transfer", { from, to, amount }, () =>
        client.mutation("bank:transfer", { from, to, amount }),
      );
    } else if (x < 0.82) {
      await h.invoke(c, "bank:all", {}, () => client.query("bank:all", { nonce: value() }));
    } else if (x < 0.9) {
      const token = `c${c}t${tokens++}`;
      await h.invoke(c, "set:add", { token }, () => client.mutation("set:add", { token }));
    } else if (x < 0.95) {
      // read-your-writes: once the mutation's promise resolves, the subscription already shows it
      const v = value();
      const op = await h.invoke(c, "reg:write", { key: own, value: v }, () =>
        client.mutation("reg:write", { key: own, value: v }),
      );
      if (op.status === "ok") {
        const shown = local(client, "reg:read", { key: own });
        if (shown !== v && !(typeof shown === "string" && expected(shown)))
          violations.push(
            `read-your-writes: client ${c} wrote ${v} to ${own}, its subscription showed ${String(shown)}`,
          );
      }
    } else {
      // a burst of pipelined mutations on one connection: they must commit in the order sent
      const n = 2 + r.int(4);
      await Promise.all(
        Array.from({ length: n }, () => {
          const s = seq++;
          return h.invoke(c, "log:append", { client: c, seq: s }, () =>
            client.mutation("log:append", { client: c, seq: s }),
          );
        }),
      );
    }
  }
  offTransition();
  for (const u of unsub) u();
}

/** A subscription's current local value; a failed query reads as its error (localQueryResult throws it). */
function local(client: BunvexClient, name: string, args: Record<string, string>): unknown {
  try {
    return client.client.localQueryResult(name, args);
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Every client's balance subscriptions reach the final balances within a while. */
async function converge(clients: BunvexClient[], finalBank: Record<string, number>, violations: string[]) {
  for (const [i, client] of clients.entries()) {
    const sub = ACCOUNTS.map((name) =>
      client.onUpdate(
        "bank:balance",
        { name },
        () => {},
        () => {},
      ),
    );
    const want = JSON.stringify(ACCOUNTS.map((n) => finalBank[n]));
    let got = "";
    for (let t = 0; t < 400; t++) {
      got = JSON.stringify(ACCOUNTS.map((name) => local(client, "bank:balance", { name })));
      if (got === want) break;
      await Bun.sleep(10);
    }
    if (got !== want)
      violations.push(`convergence: client ${i}'s subscriptions stayed at ${got}, the final state is ${want}`);
    for (const u of sub) u();
  }
}

/** Keep the first few findings of each kind (the word before the colon) and count the rest. */
export function summarize(violations: readonly string[], keep = 5): string[] {
  const byKind = new Map<string, string[]>();
  for (const v of violations) {
    const kind = v.slice(0, v.indexOf(":"));
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(v);
  }
  const out: string[] = [];
  for (const [kind, vs] of byKind) {
    out.push(...vs.slice(0, keep));
    if (vs.length > keep) out.push(`${kind}: … and ${vs.length - keep} more`);
  }
  return out;
}

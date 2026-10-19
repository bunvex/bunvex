// STUDY-168: escape and limit tests for the sandboxed executor prototype, against today's `vm` executor.
// Opt-in (they spawn processes and, on Linux, need root for cgroups and bubblewrap):
//   SANDBOX_STUDY=1 bun test bench/process-sandbox
// The `vm` half runs anywhere and documents what app code reaches today (DV-164). The sandbox half runs on Linux
// with bwrap; SANDBOX_SABOTAGE=<net,fs,env,seccomp,cgroup,timeout,memory> drops a protection (host.ts) to check
// that these tests catch it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oomMessage, timeoutMessage } from "./host.ts";
import { type Mode, setup } from "./setup.ts";

const enabled = process.env.SANDBOX_STUDY === "1";
/** Env SANDBOX_MODE: "bwrap" (namespaces, the default) or "confine" (no namespaces: uid, Landlock, seccomp, rlimits). */
const SANDBOX = (process.env.SANDBOX_MODE ?? "bwrap") as "bwrap" | "confine";
const linuxSandbox =
  enabled &&
  process.platform === "linux" &&
  existsSync(
    SANDBOX === "bwrap" ? (process.env.SANDBOX_BWRAP ?? "/usr/bin/bwrap") : join(import.meta.dir, "confine"),
  ) &&
  // SANDBOX_UNPRIVILEGED=1: a non-root host with a delegated cgroup and bwrap's AppArmor profile (study §10.5).
  (process.getuid?.() === 0 || process.env.SANDBOX_UNPRIVILEGED === "1");

const SECRET_ENV = "BUNVEX_STUDY_SECRET";
const secretDir = join(
  process.platform === "linux" && process.getuid?.() === 0 ? "/root" : (process.env.HOME ?? tmpdir()),
  `bunvex-study-secret-${process.pid}`,
);
const secretFile = join(secretDir, "admin-key.txt");
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  if (!enabled) return;
  process.env[SECRET_ENV] = "s3cr3t-admin-key";
  mkdirSync(secretDir, { recursive: true });
  writeFileSync(secretFile, "s3cr3t-admin-key");
  // Stands in for the host's own HTTP port (the admin API, the database's port).
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("host") });
});
afterAll(() => {
  server?.stop(true);
  rmSync(secretDir, { recursive: true, force: true });
});

const probe = () => ({ hostPid: process.pid, hostPort: server?.port ?? 1, secretFile, secretEnv: SECRET_ENV });
type Report = Record<string, string>;

async function escapes(mode: Mode): Promise<Report> {
  const s = await setup(mode, { memoryMiB: 128, pidsMax: 64 });
  try {
    return (await s.functions.runAction("sb:escapes", probe())) as Report;
  } finally {
    await s.close();
  }
}

describe.skipIf(!enabled)("today: the vm executor is not a boundary (DV-164)", () => {
  test("app code reaches the host's process, secrets, files, network and other processes", async () => {
    const r = await escapes("vm");
    for (const k of ["process", "env", "fsRead", "fsWrite", "network", "signalHost", "forkBomb"])
      expect(`${k}: ${r[k]}`).toStartWith(`${k}: ESCAPED`);
    if (process.platform === "linux") {
      expect(r.hostEnviron).toStartWith("ESCAPED");
      expect(r.hostCmdline).toStartWith("ESCAPED");
    }
  }, 30_000);

  test("a synchronous loop is never interrupted (DV-208)", async () => {
    // In a child process, so the loop does not take this test runner with it.
    const script = join(import.meta.dir, "vm-spin.ts");
    const p = Bun.spawn([process.execPath, script], { stdio: ["ignore", "pipe", "inherit"] });
    const done = await Promise.race([p.exited.then(() => "exited"), Bun.sleep(4000).then(() => "still running")]);
    p.kill("SIGKILL");
    await p.exited;
    expect(done).toBe("still running");
  }, 10_000);
});

describe.skipIf(!linuxSandbox)(`sandboxed process (${SANDBOX})`, () => {
  test("every escape is blocked", async () => {
    const r = await escapes(SANDBOX);
    for (const [k, v] of Object.entries(r)) {
      // `process` is the child's own (a real Bun process, holding nothing): what matters is what it can reach.
      if (k === "process") continue;
      expect(`${k}: ${v}`).toStartWith(`${k}: blocked`);
    }
  }, 30_000);

  test("an infinite loop is killed at the user timeout and the deployment recovers", async () => {
    const s = await setup(SANDBOX, { memoryMiB: 128 });
    try {
      const t = performance.now();
      let message = "returned";
      try {
        await s.functions.runQuery("sb:spin", {});
      } catch (e) {
        message = (e as Error).message;
      }
      const ms = performance.now() - t;
      expect(message).toContain(timeoutMessage(1000));
      expect(ms).toBeLessThan(2500);
      expect(await s.functions.runQuery("sb:empty", { nonce: 1 })).toBeNull();
    } finally {
      await s.close();
    }
  }, 20_000);

  // "confine" has no cgroup of its own: the container's memory limit is the only cap.
  test.skipIf(SANDBOX === "confine")(
    "an allocating loop is stopped at the memory cap, reported, and the host survives",
    async () => {
      const s = await setup(SANDBOX, { memoryMiB: 128, userTimeoutMs: 10_000 });
      try {
        let message = "returned";
        try {
          await s.functions.runQuery("sb:allocate", {});
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toContain(oomMessage(128));
        expect(s.dep?.lastDeath?.reason).toBe("oom");
        expect(s.dep?.lastDeath?.peakMiB).toBeLessThanOrEqual(128);
        expect(process.memoryUsage().rss).toBeLessThan(2 ** 30);
        expect(await s.functions.runQuery("sb:empty", { nonce: 2 })).toBeNull();
      } finally {
        await s.close();
      }
    },
    30_000,
  );

  test("the host refuses ops a function's kind does not allow, whatever the child sends", async () => {
    const s = await setup(SANDBOX, { memoryMiB: 128 });
    try {
      const refused = (await s.functions.runQuery("sb:forgeInsert", {})) as string[];
      expect(refused.length).toBeGreaterThan(0);
      for (const m of refused) expect(m).toBe("insert is not available in a query");
      expect(await s.functions.runQuery("sb:page", { n: 100 })).toBe(0);
    } finally {
      await s.close();
    }
  }, 20_000);

  test("results match the vm executor", async () => {
    const results: Record<string, unknown[]> = {};
    for (const mode of ["vm", SANDBOX] as const) {
      const s = await setup(mode, { memoryMiB: 128 });
      const f = s.functions;
      const ids = (await f.runMutation("sb:seed", { tenants: 2, perTenant: 30, counters: 2 })) as string[];
      const out = [
        await f.runQuery("sb:getMany", { ids: ids.slice(0, 10) }),
        await f.runQuery("sb:page", { n: 10 }),
        ((await f.runQuery("sb:listByTenant", { tenantId: "t1" })) as { title: string }[]).map((d) => d.title),
        await f.runQuery("sb:openAmountOver", { tenantId: "t0", min: 3000 }),
        await f.runMutation("sb:increment", { key: "k1" }),
        await f.runAction("sb:readThenWrite", { tenantId: "t0" }),
        await f.runQuery("sb:page", { n: 100 }),
        ((await f.runQuery("sb:clock", {})) as { same: boolean }).same,
        await f.runQuery("sb:throws", {}).catch((e) => (e as Error).message.includes("boom from the app")),
      ];
      results[mode] = out;
      await s.close();
    }
    expect(results[SANDBOX]).toEqual(results.vm as unknown[]);
  }, 30_000);
});

// The first round's findings, fixed in the prototype (study §10). Linux sandbox when there is one, else a plain child.
const FIX_MODE = linuxSandbox ? SANDBOX : "process";
describe.skipIf(!enabled)(`fixes (${FIX_MODE})`, () => {
  test("user time is the child's own JS time: 10 000 sequential inserts fit in the 1 s budget", async () => {
    const s = await setup(FIX_MODE, { memoryMiB: 256, accounting: "child" });
    try {
      expect(await s.functions.runMutation("sb:insertMany", { n: 10_000 })).toBe(10_000);
      // A loop is still stopped: by the host's backstop, at the budget plus the slack.
      const t = performance.now();
      const e = await s.functions.runQuery("sb:spin", {}).catch((x) => x as Error);
      expect((e as Error).message).toContain(timeoutMessage(1000));
      expect(performance.now() - t).toBeLessThan(2500);
    } finally {
      await s.close();
    }
  }, 60_000);

  test("a pool of one-call processes: a timeout fails only the guilty call", async () => {
    const s = await setup(FIX_MODE, { memoryMiB: 128, poolSize: 3 });
    try {
      const calls = [
        s.functions.runQuery("sb:spin", {}),
        ...Array.from({ length: 6 }, (_, i) => s.functions.runQuery("sb:page", { n: 1, nonce: i })),
      ];
      const settled = await Promise.allSettled(calls);
      expect(settled[0]?.status).toBe("rejected");
      expect(String((settled[0] as PromiseRejectedResult).reason?.message)).toContain(timeoutMessage(1000));
      for (const r of settled.slice(1)) expect(r.status).toBe("fulfilled");
      expect(await s.functions.runQuery("sb:empty", { nonce: 99 })).toBeNull();
    } finally {
      await s.close();
    }
  }, 30_000);

  test("batched ops give the same results", async () => {
    const results: Record<string, unknown[]> = {};
    for (const [label, mode, batchOps] of [
      ["vm", "vm", false],
      ["batched", FIX_MODE, true],
    ] as const) {
      const s = await setup(mode, { memoryMiB: 128, batchOps });
      const f = s.functions;
      const ids = (await f.runMutation("sb:seed", { tenants: 2, perTenant: 30, counters: 2 })) as string[];
      results[label] = [
        await f.runQuery("sb:getManyParallel", { ids: ids.slice(0, 50) }),
        await f.runQuery("sb:getMany", { ids: ids.slice(0, 10) }),
        await f.runAction("sb:readThenWrite", { tenantId: "t0" }),
        await f.runQuery("sb:page", { n: 100 }),
      ];
      await s.close();
    }
    expect(results.batched).toEqual(results.vm as unknown[]);
  }, 30_000);
});

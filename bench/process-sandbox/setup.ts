// STUDY-168: one engine and `Functions` with app/sb.ts loaded the way a mode runs it.
//   "vm":      today's executor: the module bundled as a push bundles it and loaded into a `CodeVersion` (`node:vm`).
//   "process": the sandboxed executor's host and child without any OS sandbox (macOS dev, and the IPC cost alone).
//   "bwrap":   the same child inside bubblewrap + seccomp + a cgroup (Linux).
import { Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { Functions } from "bunvex/server";
import { CodeVersion } from "../../packages/server/src/code-version.ts";
import { benchSchema } from "../functions.ts";
import { SandboxedDeployment, type SandboxOptions } from "./host.ts";

export type Mode = "vm" | "process" | "bwrap" | "seatbelt" | "confine";
export const APP = `${import.meta.dir}/app/sb.ts`;

export async function bundle(path = APP): Promise<string> {
  const out = await Bun.build({ entrypoints: [path], external: ["bunvex/*"], format: "esm", target: "browser" });
  if (!out.success) throw new Error(out.logs.join("\n"));
  return out.outputs[0]!.text();
}

// The benchmarks measure capacity: the write throughput limits are lifted, as bench/server.ts does.
process.env.MAX_BYTES_WRITTEN_PER_SECOND ||= String(Number.MAX_SAFE_INTEGER);
process.env.MAX_ROWS_WRITTEN_PER_SECOND ||= String(Number.MAX_SAFE_INTEGER);

export async function setup(mode: Mode, opts: Partial<SandboxOptions> = {}) {
  const engine = await new Engine(benchSchema, await MemoryPersistence.open(null, { durable: false })).init();
  const functions = new Functions(engine);
  let dep: SandboxedDeployment | null = null;
  let spawnToReadyMs: number | null = null;
  if (mode === "vm") {
    const version = await CodeVersion.load([{ path: "sb.js", source: await bundle(), environment: "isolate" }], {
      seed: Uint32Array.of(1, 2, 3, 4),
      timestamp: Date.now(),
    });
    const fns: Record<string, never> = {};
    for (const [key, f] of version.functions) fns[key.slice(key.indexOf(":") + 1)] = f as never;
    functions.register("sb", fns);
  } else {
    dep = new SandboxedDeployment({ app: APP, sandbox: mode === "process" ? "none" : mode, ...opts });
    const started = await dep.start();
    spawnToReadyMs = started.spawnToReadyMs;
    for (const [mod, fns] of Object.entries(dep.stubs(started.functions))) functions.register(mod, fns as never);
  }
  return {
    engine,
    functions,
    dep,
    spawnToReadyMs,
    async close() {
      await dep?.stop();
      await engine.close?.();
    },
  };
}

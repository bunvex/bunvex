// A driver module whose store opens in the suite's own process but not in its child processes: each child
// (child.ts, lease-child.ts, batch-child.ts) dies before it prints `start`, with a line on stderr.
import { mkdirSync, rmSync } from "node:fs";
import type { OpenOptions } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";

const inChild = /child\.ts$/.test(process.argv[1] ?? "");

export async function open(fresh: boolean, opts: OpenOptions = {}) {
  if (inChild) {
    console.error("crashing-driver: refusing to open in a child process");
    process.exit(7);
  }
  const dir = process.env.DIR!;
  mkdirSync(dir, { recursive: true });
  const log = `${dir}/memory.log`;
  if (fresh) for (const f of [log, `${log}.read-only`]) rmSync(f, { force: true });
  return MemoryPersistence.open(log, { durable: true, ...opts });
}

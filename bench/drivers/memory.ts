// Driver module for the conformance suite: memory + log, in $DIR (default ./.data/conformance).
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";

const dir = process.env.DIR ?? `${import.meta.dir}/../../.data/conformance`;
const log = `${dir}/memory.log`;
export async function open(fresh: boolean) {
  mkdirSync(dir, { recursive: true });
  if (fresh) rmSync(log, { force: true });
  return MemoryPersistence.open(log, { durable: true });
}
/** K7: half a record at the end of the log, no newline. */
export function tearTail(nextTs: number) {
  appendFileSync(log, `{"ts":${nextTs},"docs":[{"table":1,"id":"torn","json":"{\\"a`);
}

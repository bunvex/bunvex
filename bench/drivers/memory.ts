// Driver module for the conformance suite: memory + log, in $DIR (default ./.data/conformance).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { OpenOptions } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";

const dir = process.env.DIR ?? `${import.meta.dir}/../../.data/conformance`;
const log = `${dir}/memory.log`;
export async function open(fresh: boolean, opts: OpenOptions = {}) {
  mkdirSync(dir, { recursive: true });
  if (fresh) for (const f of [log, `${log}.read-only`]) rmSync(f, { force: true });
  return MemoryPersistence.open(log, { durable: true, ...opts });
}
/** K7: half a record at the end of the log, no newline. */
export function tearTail(nextTs: bigint) {
  appendFileSync(log, `{"ts":"${nextTs}","docs":[{"table":1,"id":"torn","json":"{\\"a`);
}

// K22: the layout header is a log record `{"layout":N}` (the first line, or appended to an older log).
const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const isHeader = (l: string) => l.startsWith(`{"layout":`);
export async function layoutVersion() {
  const h = lines().find(isHeader);
  return h === undefined ? null : JSON.parse(h).layout;
}
export async function setLayoutVersion(v: unknown) {
  const rest = lines().filter((l) => !isHeader(l));
  const head = v === null ? [] : [JSON.stringify({ layout: v })];
  writeFileSync(log, [...head, ...rest].map((l) => `${l}\n`).join(""));
}
const FOREIGN = "2026-10-01 12:00:00 INFO server started\n2026-10-01 12:00:01 INFO listening\n";
export async function makeForeign() {
  mkdirSync(dir, { recursive: true });
  rmSync(`${log}.read-only`, { force: true });
  writeFileSync(log, FOREIGN);
}
export async function foreignIntact() {
  return readFileSync(log, "utf8") === FOREIGN;
}

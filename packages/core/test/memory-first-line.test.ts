// A memory log whose very first write was torn by a crash (PERSIST-01 C10, K7): the open must cut the partial
// line off and start the log over, not refuse the log as foreign. The open peeks at the first line before it
// replays; a first line with no terminator is never complete, however short the file.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYOUT_VERSION, LayoutError } from "../src/persistence/layout.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const logPath = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-memory-"));
  dirs.push(d);
  return join(d, "log.jsonl");
};
const HEADER = `${JSON.stringify({ layout: LAYOUT_VERSION })}\n`;

test("a header torn during the first write is cut off, and the log starts over", async () => {
  for (const torn of ["{", '{"layo', HEADER.slice(0, -1)]) {
    const path = logPath();
    writeFileSync(path, torn);
    const m = await MemoryPersistence.open(path, { durable: false });
    expect(m.maxTs()).toBe(0n);
    m.apply(1n, [{ table: "t", id: "a", json: '"x"', prevTs: null }], []);
    await m.flush();
    await m.close();
    expect(readFileSync(path, "utf8").startsWith(HEADER)).toBe(true);
    const again = await MemoryPersistence.open(path, { durable: false });
    expect(again.get("t", "a", 1n)).toEqual({ json: '"x"', ts: 1n });
    await again.close();
  }
});

test("a short first line without a terminator that is not JSON is still refused", async () => {
  const path = logPath();
  writeFileSync(path, "hello");
  await expect(MemoryPersistence.open(path, { durable: false })).rejects.toBeInstanceOf(LayoutError);
  expect(readFileSync(path, "utf8")).toBe("hello");
});

// The import's ZIP reader (STUDY-42 PR 3): archives written by Info-ZIP (stored, deflated, forced ZIP64,
// streamed with data descriptors) and by bunvex's own writer, read by byte ranges; damage is refused.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidZipError, type RangeSource, ZipReader } from "../src/zip-reader.ts";
import { ZipFileWriter } from "../src/zip-writer.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-zip-"));
  dirs.push(d);
  return d;
};

/** Ranges of an in-memory archive, counting what was read. */
function source(bytes: Uint8Array) {
  const s = {
    read: 0,
    size: bytes.length,
    async read_(start: number, end: number) {
      s.read += end - start + 1;
      return bytes.slice(start, end + 1);
    },
  };
  const src: RangeSource = {
    size: bytes.length,
    read: (a, b) => s.read_(a, b),
    stream: async (a, b) => new Blob([await s.read_(a, b)]).stream(),
  };
  return { src, stats: s };
}

const text = async (it: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts).toString();
};

test("Info-ZIP archives: stored, deflated, forced ZIP64, and streamed with data descriptors", async () => {
  const d = tmp();
  writeFileSync(join(d, "a.txt"), "hello\n");
  writeFileSync(join(d, "b.txt"), "x".repeat(5000));
  const zip = (args: string[], stdin?: string) => {
    const r = Bun.spawnSync(["zip", "-q", ...args], {
      cwd: d,
      stdin: stdin === undefined ? undefined : Buffer.from(stdin),
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout;
  };
  zip(["plain.zip", "a.txt", "b.txt"]);
  zip(["-fz", "z64.zip", "a.txt", "b.txt"]);
  const piped = zip(["-fz", "-", "-"], "from a pipe\n");
  for (const [name, bytes] of [
    ["plain.zip", new Uint8Array(await Bun.file(join(d, "plain.zip")).arrayBuffer())],
    ["z64.zip", new Uint8Array(await Bun.file(join(d, "z64.zip")).arrayBuffer())],
  ] as const) {
    const r = await ZipReader.open(source(bytes).src);
    expect(r.entries.map((e) => [e.name, e.method, e.usize])).toEqual([
      ["a.txt", 0, 6],
      ["b.txt", 8, 5000],
    ]);
    expect(await text(r.read(r.entries[0]!))).toBe("hello\n");
    expect(await text(r.read(r.entries[1]!))).toBe("x".repeat(5000));
    void name;
  }
  const p = await ZipReader.open(source(new Uint8Array(piped)).src);
  expect(await text(p.read(p.entries[0]!))).toBe("from a pipe\n");
});

test("bunvex's own exports; only the ranges an entry needs are read", async () => {
  const d = tmp();
  const w = new ZipFileWriter(join(d, "x.zip"));
  await w.add("README.md", "readme");
  await w.add("big/documents.jsonl", "y".repeat(200_000));
  await w.add("small/documents.jsonl", '{"a":1}\n');
  await w.finish();
  const bytes = new Uint8Array(await Bun.file(w.path).arrayBuffer());
  const { src, stats } = source(bytes);
  const r = await ZipReader.open(src);
  expect(r.entries.map((e) => e.name)).toEqual(["README.md", "big/documents.jsonl", "small/documents.jsonl"]);
  const before = stats.read;
  expect(await text(r.read(r.entries[2]!))).toBe('{"a":1}\n');
  // The small entry: its local header and its bytes, not the archive.
  expect(stats.read - before).toBeLessThan(200);
});

test("damage is refused: no end record, a bad checksum", async () => {
  await expect(ZipReader.open(source(new TextEncoder().encode("not a zip file at all, really")).src)).rejects.toThrow(
    InvalidZipError,
  );
  const d = tmp();
  const w = new ZipFileWriter(join(d, "x.zip"));
  await w.add("t/documents.jsonl", "z".repeat(1000));
  await w.finish();
  const bytes = new Uint8Array(await Bun.file(w.path).arrayBuffer());
  // Flip the CRC in the central directory.
  const cd = Buffer.from(bytes).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes[cd + 16]! ^= 0xff;
  const r = await ZipReader.open(source(bytes).src);
  await expect(text(r.read(r.entries[0]!))).rejects.toThrow("checksum mismatch");
});

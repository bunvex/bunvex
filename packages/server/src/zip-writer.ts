// A ZIP writer for snapshot exports (STUDY-42), with the shape Convex's (the `zip` crate) gives them: every
// entry deflated, unix permissions 0644, a fixed 1980-01-01 timestamp; ZIP64 fields only when an entry or
// the archive outgrows 4 GiB. Each entry is compressed into a temporary file first, so its sizes and CRC are
// known when its header is written (no data descriptors), then appended to the archive file.
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createDeflateRaw } from "node:zlib";

const MAX32 = 0xffffffff;
const DOS_DATE_1980 = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const UNIX_0644 = (0o100644 << 16) >>> 0;

/** An entry compressed into a temporary file, ready to append (its uncompressed size orders tables). */
export type PreparedEntry = { name: string; tmp: string; crc: number; csize: number; usize: number };

type Central = { name: Buffer; crc: number; csize: number; usize: number; offset: number; utf8: boolean };

export class ZipFileWriter {
  private entries: Central[] = [];
  private offset = 0;
  private fd: Awaited<ReturnType<typeof open>> | null = null;
  private temps = new Set<string>();

  constructor(readonly path: string) {}

  private async file() {
    this.fd ??= await open(this.path, "w");
    return this.fd;
  }

  private async write(b: Uint8Array) {
    const fd = await this.file();
    let done = 0;
    while (done < b.length) done += (await fd.write(b, done, b.length - done, this.offset + done)).bytesWritten;
    this.offset += b.length;
  }

  private prepared = 0;

  /** Add an entry: its bytes, as one buffer or a stream of chunks. */
  async add(name: string, source: Uint8Array | string | AsyncIterable<Uint8Array>) {
    await this.append(await this.prepare(name, source));
  }

  /** Compress an entry into a temporary file, to append later. */
  async prepare(name: string, source: Uint8Array | string | AsyncIterable<Uint8Array>): Promise<PreparedEntry> {
    const tmp = `${this.path}.entry${this.prepared++}`;
    this.temps.add(tmp);
    let crc = 0;
    let usize = 0;
    const input = (async function* () {
      const it =
        typeof source === "string"
          ? [new TextEncoder().encode(source)]
          : source instanceof Uint8Array
            ? [source]
            : source;
      for await (const chunk of it) {
        crc = Bun.hash.crc32(chunk, crc);
        usize += chunk.length;
        yield chunk;
      }
    })();
    await pipeline(input, createDeflateRaw(), createWriteStream(tmp));
    return { name, tmp, crc: crc >>> 0, csize: (await stat(tmp)).size, usize };
  }

  /** Append a prepared entry: its header, then its compressed bytes. */
  async append({ name, tmp, crc, csize, usize }: PreparedEntry) {
    const nameBytes = Buffer.from(name);
    const utf8 = /[^\x20-\x7e]/.test(name);
    const offset = this.offset;
    await this.write(localHeader(nameBytes, utf8, crc, csize, usize));
    for await (const chunk of createReadStream(tmp)) await this.write(chunk as Buffer);
    await rm(tmp, { force: true });
    this.temps.delete(tmp);
    this.entries.push({ name: nameBytes, crc, csize, usize, offset, utf8 });
  }

  /** Write the central directory; the archive's size. */
  async finish(): Promise<number> {
    await this.write(centralDirectory(this.entries, this.offset));
    await this.fd?.close();
    this.fd = null;
    return this.offset;
  }

  /** Drop a partial archive (a failed or canceled export). */
  async discard() {
    await this.fd?.close().catch(() => {});
    this.fd = null;
    await rm(this.path, { force: true });
    for (const t of this.temps) await rm(t, { force: true });
    this.temps.clear();
  }
}

/** The ZIP64 extended-information extra field with the given 64-bit values, in the spec's order. */
function zip64Extra(values: number[]): Buffer {
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(8 * values.length, 2);
  for (const [i, v] of values.entries()) b.writeBigUInt64LE(BigInt(v), 4 + 8 * i);
  return b;
}

/** An entry's local header: deflated, at 1980-01-01, with ZIP64 sizes when either outgrows 4 GiB. */
function localHeader(name: Buffer, utf8: boolean, crc: number, csize: number, usize: number): Buffer {
  const zip64 = csize >= MAX32 || usize >= MAX32;
  const extra = zip64 ? zip64Extra([usize, csize]) : Buffer.alloc(0);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(zip64 ? 45 : 20, 4);
  h.writeUInt16LE(utf8 ? 0x0800 : 0, 6);
  h.writeUInt16LE(8, 8); // deflate
  h.writeUInt16LE(0, 10); // time 00:00
  h.writeUInt16LE(DOS_DATE_1980, 12);
  h.writeUInt32LE(crc >>> 0, 14);
  h.writeUInt32LE(zip64 ? MAX32 : csize, 18);
  h.writeUInt32LE(zip64 ? MAX32 : usize, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, name, extra]);
}

/** The central directory of `entries`, which starts at `cdStart`, and the end records after it. */
function centralDirectory(entries: Central[], cdStart: number): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const big = [
      e.usize >= MAX32 ? e.usize : null,
      e.csize >= MAX32 ? e.csize : null,
      e.offset >= MAX32 ? e.offset : null,
    ];
    const extra = big.some((x) => x !== null)
      ? zip64Extra(big.filter((x): x is number => x !== null))
      : Buffer.alloc(0);
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE((3 << 8) | 45, 4); // made by: unix
    h.writeUInt16LE(extra.length ? 45 : 20, 6);
    h.writeUInt16LE(e.utf8 ? 0x0800 : 0, 8);
    h.writeUInt16LE(8, 10);
    h.writeUInt16LE(0, 12);
    h.writeUInt16LE(DOS_DATE_1980, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(big[1] !== null ? MAX32 : e.csize, 20);
    h.writeUInt32LE(big[0] !== null ? MAX32 : e.usize, 24);
    h.writeUInt16LE(e.name.length, 28);
    h.writeUInt16LE(extra.length, 30);
    h.writeUInt32LE(UNIX_0644, 38);
    h.writeUInt32LE(big[2] !== null ? MAX32 : e.offset, 42);
    parts.push(h, e.name, extra);
  }
  const cdSize = parts.reduce((n, b) => n + b.length, 0);
  const n = entries.length;
  if (n >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE((3 << 8) | 45, 12);
    z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(n), 24);
    z.writeBigUInt64LE(BigInt(n), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40);
    z.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cdStart + cdSize), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(z, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(n, 0xffff), 8);
  end.writeUInt16LE(Math.min(n, 0xffff), 10);
  end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/**
 * A small archive built in memory (a code package, STUDY-35), in the same shape as `ZipFileWriter`'s: each
 * entry deflated, in the order given.
 */
export function zipInMemory(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Central[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name);
    const utf8 = /[^\x20-\x7e]/.test(name);
    const body = Bun.deflateSync(data as Uint8Array<ArrayBuffer>);
    const crc = Bun.hash.crc32(data) >>> 0;
    const head = localHeader(nameBytes, utf8, crc, body.length, data.length);
    central.push({ name: nameBytes, crc, csize: body.length, usize: data.length, offset, utf8 });
    parts.push(head, Buffer.from(body));
    offset += head.length + body.length;
  }
  parts.push(centralDirectory(central, offset));
  return new Uint8Array(Buffer.concat(parts));
}

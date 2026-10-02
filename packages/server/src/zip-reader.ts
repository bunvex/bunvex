// A ZIP reader for snapshot imports (STUDY-42 PR 3), as Convex's `StorageZipArchive`: the archive stays in
// the blob store and is read by byte ranges — the central directory once, then each entry when it is
// imported — so an archive of any size never sits in memory. Stored and deflated entries, ZIP64 included;
// each entry's CRC is checked as it is read.
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

const MAX32 = 0xffffffff;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

export type ZipEntry = { name: string; method: number; crc: number; csize: number; usize: number; offset: number };

/** The bytes of `[start, end]` (inclusive), and those of a range as a stream. */
export type RangeSource = {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
  stream(start: number, end: number): Promise<ReadableStream<Uint8Array>>;
};

/** A malformed archive: Convex's `InvalidZip`. */
export class InvalidZipError extends Error {
  constructor(detail: string) {
    super(`invalid zip file: ${detail}`);
  }
}

export class ZipReader {
  private constructor(
    private readonly src: RangeSource,
    readonly entries: ZipEntry[],
  ) {}

  static async open(src: RangeSource): Promise<ZipReader> {
    if (src.size < EOCD_SIZE) throw new InvalidZipError("too short");
    const tailStart = Math.max(0, src.size - EOCD_SIZE - MAX_COMMENT);
    const tail = Buffer.from(await src.read(tailStart, src.size - 1));
    let at = -1;
    for (let i = tail.length - EOCD_SIZE; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        at = i;
        break;
      }
    if (at < 0) throw new InvalidZipError("no end of central directory");
    let count = tail.readUInt16LE(at + 10);
    let cdSize = tail.readUInt32LE(at + 12);
    let cdStart = tail.readUInt32LE(at + 16);
    const locAt = at - 20;
    if (locAt >= 0 && tail.readUInt32LE(locAt) === 0x07064b50) {
      // ZIP64: the locator sits just before the end record.
      const z64At = Number(tail.readBigUInt64LE(locAt + 8));
      const z = Buffer.from(await src.read(z64At, z64At + 55));
      if (z.readUInt32LE(0) !== 0x06064b50) throw new InvalidZipError("no ZIP64 end of central directory");
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdStart = Number(z.readBigUInt64LE(48));
    } else if (cdStart === MAX32) {
      // No ZIP64 record (Info-ZIP writing to a pipe): the directory ends where the end record starts.
      cdStart = tailStart + at - cdSize;
    }
    if (cdStart + cdSize > src.size) throw new InvalidZipError("central directory out of bounds");
    const cd = cdSize ? Buffer.from(await src.read(cdStart, cdStart + cdSize - 1)) : Buffer.alloc(0);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new InvalidZipError("bad central directory");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x0800 ? "utf8" : "latin1");
      // The ZIP64 extra field holds, in order, the values whose 32-bit fields are saturated.
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          const next = () => {
            const v = Number(cd.readBigUInt64LE(q));
            q += 8;
            return v;
          };
          if (usize === MAX32) usize = next();
          if (csize === MAX32) csize = next();
          if (offset === MAX32) offset = next();
        }
        e += 4 + len;
      }
      p = extraEnd + commentLen;
      if (name.endsWith("/")) continue;
      if (method !== 0 && method !== 8) throw new InvalidZipError(`unsupported compression method ${method}`);
      entries.push({ name, method, crc, csize, usize, offset });
    }
    return new ZipReader(src, entries);
  }

  /** An entry's uncompressed bytes, streamed; a CRC or size mismatch throws at the end. */
  async *read(entry: ZipEntry): AsyncGenerator<Uint8Array> {
    const head = Buffer.from(await this.src.read(entry.offset, entry.offset + 29));
    if (head.readUInt32LE(0) !== 0x04034b50) throw new InvalidZipError(`bad local header for ${entry.name}`);
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    let crc = 0;
    let size = 0;
    if (entry.csize > 0) {
      const raw = Readable.fromWeb((await this.src.stream(start, start + entry.csize - 1)) as never);
      const body = entry.method === 8 ? raw.pipe(createInflateRaw()) : raw;
      try {
        for await (const chunk of body as AsyncIterable<Buffer>) {
          crc = Bun.hash.crc32(chunk, crc);
          size += chunk.length;
          yield chunk;
        }
      } catch (e) {
        raw.destroy();
        if ((e as { code?: string }).code?.startsWith("Z_"))
          throw new InvalidZipError(`${entry.name}: ${(e as Error).message}`);
        throw e;
      }
    }
    if (size !== entry.usize || crc >>> 0 !== entry.crc >>> 0)
      throw new InvalidZipError(`${entry.name}: checksum mismatch`);
  }
}

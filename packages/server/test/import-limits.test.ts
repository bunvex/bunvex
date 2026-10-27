// Import limits (Convex's 1056bba, a5de16c, 679042f; STUDY-186 A2): an upload part past
// `MAX_IMPORT_UPLOAD_PART_BYTES` (64 MiB) is a 400 `ImportPartTooLarge`; a JSON Lines line (ZIP entries too) past
// `SNAPSHOT_IMPORT_MAX_LINE_SIZE_BYTES` (16 MiB) with its `\n` is `JsonLineTooLarge`, and a CSV record (a quoted
// field's newlines inside it) `CsvRecordTooLarge`; a line that is not UTF-8 is `NotUtf8` in Rust's words. Small
// limits here, through the knobs. The oracle case: packages/differential `import-limits.test.ts`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { importMaxLineBytes, parseSingleTable, utf8Error } from "../src/import-parse.ts";
import { type ImportRequestError, importPartBody, maxImportUploadPartBytes } from "../src/imports.ts";

const LIMIT = 32;
beforeAll(() => {
  process.env.SNAPSHOT_IMPORT_MAX_LINE_SIZE_BYTES = String(LIMIT);
});
afterAll(() => {
  delete process.env.SNAPSHOT_IMPORT_MAX_LINE_SIZE_BYTES;
});

/** The rows of `body` read as `format`, in chunks of `chunk` bytes, or the error's code, message and bareness. */
async function read(format: "csv" | "jsonl", body: string | Uint8Array, chunk = 5) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const parsed = parseSingleTable({ format, table: "t" }, async () =>
    (async function* () {
      for (let i = 0; i < bytes.length; i += chunk) yield bytes.subarray(i, i + chunk);
    })(),
  );
  const rows: unknown[] = [];
  try {
    for await (const r of parsed.tables[0]!.rows()) rows.push(r.json);
    return rows;
  } catch (e) {
    const x = e as { code: string; message: string; bare: boolean };
    return { code: x.code, message: x.message, bare: x.bare };
  }
}

/** A JSON Lines line of exactly `n` bytes, its `\n` included. */
const line = (n: number) => `{"a":"${"x".repeat(n - 9)}"}\n`;

describe("the line limit", () => {
  test("the knobs' defaults are Convex's", () => {
    delete process.env.SNAPSHOT_IMPORT_MAX_LINE_SIZE_BYTES;
    expect(importMaxLineBytes()).toBe(16 * 1024 * 1024);
    expect(maxImportUploadPartBytes()).toBe(64 * 1024 * 1024);
    process.env.SNAPSHOT_IMPORT_MAX_LINE_SIZE_BYTES = String(LIMIT);
    expect(importMaxLineBytes()).toBe(LIMIT);
  });

  test("JSON Lines: a line at the limit with its \\n reads, one past it fails, named by its number", async () => {
    expect(line(LIMIT).length).toBe(LIMIT);
    for (const chunk of [1, 5, 1000]) {
      expect(await read("jsonl", `{"a":1}\n${line(LIMIT)}`, chunk)).toHaveLength(2);
      expect(await read("jsonl", `{"a":1}\n${line(LIMIT + 1)}{"a":2}\n`, chunk)).toEqual({
        code: "JsonLineTooLarge",
        message: `JSONL line 2 exceeds the maximum length of ${LIMIT} bytes`,
        bare: true,
      });
      // A last line without its \n: its bytes alone.
      expect(await read("jsonl", `{"a":1}\n${line(LIMIT + 1).slice(0, -1)}`, chunk)).toHaveLength(2);
      expect((await read("jsonl", `{"a":1}\n${line(LIMIT + 2).slice(0, -1)}`, chunk)) as object).toMatchObject({
        code: "JsonLineTooLarge",
      });
    }
    // Bytes, not characters.
    expect(await read("jsonl", `{"a":"${"é".repeat(12)}"}\n`)).toMatchObject({ code: "JsonLineTooLarge" });
  });

  test("JSON Lines: a line that is not UTF-8, in Rust's words, bare; a BOM after its line is read", async () => {
    const bad = new Uint8Array([
      ...new TextEncoder().encode('{"a":1}\n{"a":"'),
      0xff,
      ...new TextEncoder().encode('"}\n'),
    ]);
    for (const chunk of [1, 5, 1000])
      expect(await read("jsonl", bad, chunk)).toEqual({
        code: "NotUtf8",
        message: "Import wasn't valid UTF8: invalid utf-8 sequence of 1 bytes from index 6",
        bare: true,
      });
    // A row before it is read first; a sequence cut off at the end.
    const enc = (t: string) => new TextEncoder().encode(t);
    expect(await read("jsonl", new Uint8Array([...enc('{"a":1}\n{oops\n{"a":"'), 0xff, ...enc('"}\n')]))).toMatchObject(
      {
        code: "JsonInvalidRow",
      },
    );
    for (const chunk of [1, 1000])
      expect(await read("jsonl", new Uint8Array([...enc('{"a":"é"}\n{"a":"'), 0xe2, 0x82]), chunk)).toMatchObject({
        message: "Import wasn't valid UTF8: incomplete utf-8 byte sequence from index 6",
      });
    expect(await read("jsonl", '﻿{"a":1}\n')).toEqual({
      code: "Utf8BomNotSupported",
      message: "UTF-8 BOM is not supported. Please save your file without BOM.",
      bare: true,
    });
    // A first line past the limit fails as that, BOM or not.
    expect(await read("jsonl", `﻿${line(LIMIT)}`)).toMatchObject({ code: "JsonLineTooLarge" });
  });

  test("CSV: a record at the limit reads, one past it fails, its line ending and quoted newlines inside it", async () => {
    // "a\n" is record 1 (2 bytes); `"…"\n` with n bytes in all.
    const record = (n: number, end = "\n") => `"${"x".repeat(n - 2 - end.length)}"${end}`;
    for (const chunk of [1, 5, 1000]) {
      expect(await read("csv", `a\n${record(LIMIT)}`, chunk)).toHaveLength(1);
      expect(await read("csv", `a\n${record(LIMIT + 1)}`, chunk)).toEqual({
        code: "CsvRecordTooLarge",
        message: `CSV record 2 exceeds the maximum length of ${LIMIT} bytes`,
        bare: false,
      });
      // \r\n: the \n is the record's too.
      expect(await read("csv", `a\r\n${record(LIMIT, "\r\n")}`, chunk)).toHaveLength(1);
      expect(await read("csv", `a\r\n${record(LIMIT + 1, "\r\n")}`, chunk)).toMatchObject({
        code: "CsvRecordTooLarge",
        message: `CSV record 2 exceeds the maximum length of ${LIMIT} bytes`,
      });
      // A quoted field's newlines count; blank lines between records count in none.
      expect(await read("csv", `a\n"${"x".repeat(14)}\n${"y".repeat(15)}"\n`, chunk)).toMatchObject({
        code: "CsvRecordTooLarge",
      });
      expect(await read("csv", `a\n\n\n\r\n${record(LIMIT)}\n\n${record(LIMIT)}`, chunk)).toHaveLength(2);
      // The header is record 1.
      expect(await read("csv", `${"h".repeat(LIMIT)}\n1\n`, chunk)).toMatchObject({
        message: `CSV record 1 exceeds the maximum length of ${LIMIT} bytes`,
      });
    }
  });
});

describe("Rust's Utf8Error", () => {
  test("its words for each kind of bad sequence", () => {
    const at = (...b: number[]) => utf8Error(new Uint8Array(b));
    expect(at(0x61, 0xc3, 0xa9)).toBeNull();
    expect(at(0xf0, 0x9f, 0x98, 0x80)).toBeNull();
    expect(at(0x61, 0xff)).toBe("invalid utf-8 sequence of 1 bytes from index 1");
    expect(at(0x80)).toBe("invalid utf-8 sequence of 1 bytes from index 0");
    expect(at(0xc0, 0x80)).toBe("invalid utf-8 sequence of 1 bytes from index 0");
    expect(at(0xe0, 0x80, 0x80)).toBe("invalid utf-8 sequence of 1 bytes from index 0");
    expect(at(0xed, 0xa0, 0x80)).toBe("invalid utf-8 sequence of 1 bytes from index 0");
    expect(at(0xe2, 0x82, 0x41)).toBe("invalid utf-8 sequence of 2 bytes from index 0");
    expect(at(0xf0, 0x9f, 0x98, 0x41)).toBe("invalid utf-8 sequence of 3 bytes from index 0");
    expect(at(0xf4, 0x90, 0x80, 0x80)).toBe("invalid utf-8 sequence of 1 bytes from index 0");
    expect(at(0x61, 0xe2, 0x82)).toBe("incomplete utf-8 byte sequence from index 1");
    expect(at(0xf0)).toBe("incomplete utf-8 byte sequence from index 0");
  });
});

describe("an upload part", () => {
  const req = (body: RequestInit["body"], headers: Record<string, string> = {}) =>
    new Request("http://x/", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  const stream = (...sizes: number[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const n of sizes) c.enqueue(new Uint8Array(n));
        c.close();
      },
    });
  const tooLarge = (limit: number) => ({
    status: 400,
    code: "ImportPartTooLarge",
    message: `Import upload parts must be at most ${limit} bytes.`,
  });
  const outcome = (p: Promise<Uint8Array>) =>
    p.then(
      (b) => b.length,
      (e) => ({ status: (e as ImportRequestError).status, code: (e as ImportRequestError).code, message: e.message }),
    );

  test("at the limit it is read; past it, 400 ImportPartTooLarge, by its declared length or its bytes", async () => {
    expect(await outcome(importPartBody(req(new Uint8Array(100)), 100))).toBe(100);
    expect(await outcome(importPartBody(req(new Uint8Array(101)), 100))).toEqual(tooLarge(100));
    expect(await outcome(importPartBody(req(stream(60, 40)), 100))).toBe(100);
    expect(await outcome(importPartBody(req(stream(60, 41)), 100))).toEqual(tooLarge(100));
    expect(await outcome(importPartBody(req(null), 100))).toBe(0);
  });

  test("a body that breaks: 400 ImportFailed", async () => {
    const broken = new ReadableStream({
      pull(c) {
        c.error(new Error("reset"));
      },
    });
    expect(await outcome(importPartBody(req(broken), 100))).toEqual({
      status: 400,
      code: "ImportFailed",
      message: "failed to read request body",
    });
  });
});

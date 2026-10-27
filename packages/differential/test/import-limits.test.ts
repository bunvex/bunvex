// Import limits (Convex's 1056bba, a5de16c, 679042f; STUDY-186 A2), on Convex's backend (the oracle) and on bunvex's:
// an upload part past 64 MiB is a 400 `ImportPartTooLarge`; a JSON Lines line, and a CSV record (a quoted field's
// newlines inside it), past 16 MiB with its line ending fail the import with `JsonLineTooLarge` /
// `CsvRecordTooLarge`, and at the limit import. Compared: the status and body of the part, the import's final state.
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`import-limits: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex(), startBunvex()]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const authOf = (b: Backend) => `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;
const MiB = 1 << 20;
type RequestBody = NonNullable<RequestInit["body"]>;

async function post(b: Backend, path: string, body?: RequestBody) {
  const r = await fetch(`${b.url}${path}`, {
    method: "POST",
    headers: {
      authorization: authOf(b),
      ...(typeof body === "string" && path.endsWith("_upload") ? { "content-type": "application/json" } : {}),
    },
    body,
  });
  const text = await r.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, body: json };
}

async function startUpload(b: Backend) {
  return ((await post(b, "/api/import/start_upload")).body as { uploadToken: string }).uploadToken;
}

const part = (b: Backend, token: string, body: RequestBody) =>
  post(b, `/api/import/upload_part?uploadToken=${encodeURIComponent(token)}&partNumber=1`, body);

async function sys(b: Backend, path: string) {
  const r = await fetch(`${b.url}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: authOf(b) },
    body: JSON.stringify({ path, args: {}, format: "json" }),
  });
  return ((await r.json()) as { value: unknown }).value;
}

let tables = 0;
/** An import of `body` as one part, in `format`: its final state (failed, or waiting for confirmation). */
async function imported(b: Backend, format: "jsonLines" | "csv", body: Uint8Array | string, table: string) {
  const token = await startUpload(b);
  const p = await part(b, token, body);
  expect(p.status).toBe(200);
  const finished = await post(
    b,
    "/api/import/finish_upload",
    JSON.stringify({
      import: { format, tableName: table, mode: "requireEmpty" },
      uploadToken: token,
      partTokens: [p.body],
    }),
  );
  expect(finished.status).toBe(200);
  for (let i = 0; i < 600; i++) {
    const list = (await sys(b, "_system/frontend/snapshotImport:list")) as {
      state: { state: string; error_message?: string };
    }[];
    const s = list[0]?.state;
    if (s && s.state !== "uploaded" && s.state !== "in_progress") return s;
    await Bun.sleep(100);
  }
  throw new Error("timed out");
}

async function same(format: "jsonLines" | "csv", body: Uint8Array | string, table = `t${tables++}`) {
  const c = await imported(convex, format, body, table);
  const b = await imported(bunvex, format, body, table);
  // The confirmation names each one's CLI (rule 5).
  expect(JSON.parse(JSON.stringify(b).replace("`bunvex import`", "`npx convex import`"))).toEqual(c);
  return c;
}

/** A JSON Lines line of exactly `n` bytes, its `\n` included. */
const line = (n: number) => `{"a":"${"x".repeat(n - 9)}"}\n`;
/** A CSV record of exactly `n` bytes: one quoted field, a newline inside it, and `end`. */
const record = (n: number, end = "\n") => {
  const inner = n - 2 - end.length - 1;
  return `"${"x".repeat(Math.floor(inner / 2))}\n${"y".repeat(Math.ceil(inner / 2))}"${end}`;
};
const LIMIT = 16 * MiB;

/** A one-shot import's answer (`POST /api/import`). */
async function now(b: Backend, format: string, body: string) {
  const r = await fetch(`${b.url}/api/import?format=${format}&tableName=n${tables++}`, {
    method: "POST",
    headers: { authorization: authOf(b) },
    body,
  });
  return { status: r.status, body: (await r.json()) as { code: string; message: string } };
}

describe.skipIf(!ready)("import limits, against Convex's backend", () => {
  test("an upload part: 64 MiB is taken, one byte more is a 400, declared or streamed", async () => {
    const streamed = (n: number) =>
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(n));
          c.close();
        },
      });
    for (const body of [() => new Uint8Array(64 * MiB + 1), () => streamed(64 * MiB + 1)]) {
      const c = await part(convex, await startUpload(convex), body() as RequestBody);
      const b = await part(bunvex, await startUpload(bunvex), body() as RequestBody);
      expect(b).toEqual(c);
      expect(c).toEqual({
        status: 400,
        body: { code: "ImportPartTooLarge", message: "Import upload parts must be at most 67108864 bytes." },
      });
    }
    for (const b of [convex, bunvex])
      expect((await part(b, await startUpload(b), new Uint8Array(64 * MiB))).status).toBe(200);
  }, 120_000);

  test("JSON Lines: 16 MiB a line with its \\n; past it, JsonLineTooLarge", async () => {
    expect((await same("jsonLines", `{"a":1}\n${line(LIMIT)}`)).state).toBe("waiting_for_confirmation");
    const over = await same("jsonLines", `{"a":1}\n${line(LIMIT + 1)}{"a":2}\n`);
    expect(over).toEqual({
      state: "failed",
      error_message: "JSONL line 2 exceeds the maximum length of 16777216 bytes",
    });
    // The last line, without its \n.
    expect((await same("jsonLines", `{"a":1}\n${line(LIMIT + 1).slice(0, -1)}`)).state).toBe(
      "waiting_for_confirmation",
    );
    expect((await same("jsonLines", `{"a":1}\n${line(LIMIT + 2).slice(0, -1)}`)).state).toBe("failed");
  }, 300_000);

  test("CSV: 16 MiB a record, a quoted field's newlines and its line ending inside it; past it, CsvRecordTooLarge", async () => {
    expect((await same("csv", `a\n${record(LIMIT)}`)).state).toBe("waiting_for_confirmation");
    expect(await same("csv", `a\n${record(LIMIT + 1)}`)).toEqual({
      state: "failed",
      error_message: "Hit an error while importing:\nCSV record 2 exceeds the maximum length of 16777216 bytes",
    });
    expect((await same("csv", `a\r\n${record(LIMIT, "\r\n")}`)).state).toBe("waiting_for_confirmation");
    expect((await same("csv", `a\r\n${record(LIMIT + 1, "\r\n")}`)).state).toBe("failed");
    expect((await same("csv", `a\n\n\n${record(LIMIT)}\n\n${record(LIMIT)}`)).state).toBe("waiting_for_confirmation");
  }, 300_000);

  test("a line that is not UTF-8, in Rust's words; Convex's own import errors unprefixed, others prefixed", async () => {
    const bad = new Uint8Array([...Buffer.from('{"a":1}\n{"a":"'), 0xff, ...Buffer.from('"}\n')]);
    expect(await same("jsonLines", bad)).toEqual({
      state: "failed",
      error_message: "Import wasn't valid UTF8: invalid utf-8 sequence of 1 bytes from index 6",
    });
    for (const [format, body] of [
      ["jsonLines", '\ufeff{"a":1}\n'],
      ["jsonArray", '\ufeff[{"a":1}]'],
      ["jsonArray", '{"a":1}'],
      ["csv", "a,b\n1,2,3\n"],
    ] as const) {
      const c = await now(convex, format, body);
      expect({ format, body, b: await now(bunvex, format, body) }).toEqual({ format, body, b: c });
      expect(c.body.message).not.toStartWith("Hit an error while importing");
    }
    // An existing table, refused at the summary.
    for (const b of [convex, bunvex]) {
      const r = await fetch(`${b.url}/api/import?format=jsonLines&tableName=filled`, {
        method: "POST",
        headers: { authorization: authOf(b) },
        body: '{"a":1}\n',
      });
      expect(r.status).toBe(200);
    }
    expect(await same("jsonLines", '{"a":1}\n', "filled")).toEqual({
      state: "failed",
      error_message: "Table filled already exists. Please choose a new table name or use replace/append modes.",
    });
    // The parser's own words differ (DV-222); the prefix does not.
    for (const b of [convex, bunvex])
      expect((await now(b, "jsonLines", '{"a":1}\n{oops\n')).body.message).toStartWith("Row 2 wasn't valid JSON: ");
    // A document's own error is not one of them: prefixed on both.
    for (const b of [convex, bunvex])
      expect((await now(b, "jsonLines", '{"_x":1}\n')).body.message).toStartWith("Hit an error while importing:\n");
  }, 120_000);
});

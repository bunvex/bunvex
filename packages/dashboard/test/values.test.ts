import { describe, expect, test } from "bun:test";
import { cellText, documentFields, formatTime, literal } from "../src/database/values.ts";
import { encodeInt64 } from "../src/filters.ts";

describe("document values", () => {
  test("columns: _id first, then fields in order of first appearance, _creationTime last", () => {
    expect(
      documentFields([
        { _id: "a", _creationTime: 1, text: "x", done: true },
        { _id: "b", _creationTime: 2, owner: "u", text: "y" },
      ]),
    ).toEqual(["_id", "text", "done", "owner", "_creationTime"]);
    expect(documentFields([])).toEqual(["_id", "_creationTime"]);
  });

  test("a missing field is not null", () => {
    expect(cellText("x", undefined)).toEqual({ text: "unset", kind: "missing" });
    expect(cellText("x", null)).toEqual({ text: "null", kind: "null" });
  });

  test("ids, times, scalars, int64, bytes and compact literals", () => {
    expect(cellText("owner", "0123456789abcdefghjkmnpqrstvwxyz").kind).toBe("id");
    expect(cellText("text", "hello")).toEqual({ text: "hello", kind: "string" });
    expect(cellText("_creationTime", new Date(2026, 8, 29, 12, 4, 5).getTime()).text).toBe("2026-09-29 12:04:05");
    expect(cellText("n", 3.5)).toEqual({ text: "3.5", kind: "number" });
    expect(cellText("b", false)).toEqual({ text: "false", kind: "boolean" });
    expect(cellText("c", encodeInt64(-12n))).toEqual({ text: "-12n", kind: "int64" });
    expect(cellText("h", { $bytes: "AAE=" })).toEqual({ text: 'Bytes("AAE=")', kind: "bytes" });
    expect(cellText("tags", ["a", encodeInt64(1n)])).toEqual({ text: '["a", 1n]', kind: "json" });
    expect(literal({ edited: true, at: 3 })).toBe("{ edited: true, at: 3 }");
    expect(cellText("big", { s: "x".repeat(200) }).text).toHaveLength(120);
  });

  test("time is zero-padded", () => {
    expect(formatTime(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe("2026-01-02 03:04:05");
  });
});

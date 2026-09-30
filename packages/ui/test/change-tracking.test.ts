import { describe, expect, test } from "bun:test";
import { cellKey, diffSnapshots, snapshotOf } from "@bunvex/ui/lib/change-tracking";

const snap = (rows: [string, Record<string, unknown>][]) =>
  snapshotOf(rows.map(([id, cells]) => ({ id, cells: Object.entries(cells) })));

describe("change tracking", () => {
  test("a changed value is a changed cell, whatever the row's position", () => {
    const prev = snap([
      ["a", { n: 1, s: "x" }],
      ["b", { n: 2, s: "y" }],
    ]);
    const next = snap([
      ["b", { n: 2, s: "Y" }],
      ["a", { n: 1, s: "x" }],
    ]); // reordered, b.s changed
    expect(diffSnapshots(prev, next, ["b", "a"])).toEqual({ changed: [cellKey("b", "s")], added: [] });
  });

  test("deep values compare by content; unset differs from null", () => {
    const prev = snap([["a", { o: { x: [1, 2] }, m: null }]]);
    expect(diffSnapshots(prev, snap([["a", { o: { x: [1, 2] }, m: null }]]), ["a"]).changed).toEqual([]);
    expect(diffSnapshots(prev, snap([["a", { o: { x: [1, 3] }, m: undefined }]]), ["a"]).changed).toEqual([
      cellKey("a", "o"),
      cellKey("a", "m"),
    ]);
  });

  test("a column only one side has is not a change", () => {
    const prev = snap([["a", { n: 1 }]]);
    const next = snap([["a", { n: 1, extra: undefined }]]);
    expect(diffSnapshots(prev, next, ["a"]).changed).toEqual([]);
  });

  test("rows inserted above or between are added; rows appended at the end are the next page", () => {
    const prev = snap([
      ["b", {}],
      ["c", {}],
    ]);
    const next = snap([
      ["new1", {}],
      ["b", {}],
      ["mid", {}],
      ["c", {}],
      ["page2a", {}],
      ["page2b", {}],
    ]);
    expect(diffSnapshots(prev, next, ["new1", "b", "mid", "c", "page2a", "page2b"]).added).toEqual(["new1", "mid"]);
  });

  test("against an empty list nothing is added", () => {
    expect(diffSnapshots(new Map(), snap([["a", {}]]), ["a"])).toEqual({ changed: [], added: [] });
  });
});

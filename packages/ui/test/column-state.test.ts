import { describe, expect, test } from "bun:test";
import { clampWidth, mergeColumnOrder, moveColumn } from "@bunvex/ui/lib/column-state";

describe("column state", () => {
  test("the saved order wins; a new column lands after its natural predecessor", () => {
    const saved = ["owner", "_id", "text", "done", "_creationTime"];
    expect(mergeColumnOrder(saved, ["_id", "text", "done", "owner", "_creationTime"])).toEqual(saved);
    // "priority" appears (naturally after "owner"): it follows owner; _creationTime stays last
    expect(mergeColumnOrder(saved, ["_id", "text", "done", "owner", "priority", "_creationTime"])).toEqual([
      "owner",
      "priority",
      "_id",
      "text",
      "done",
      "_creationTime",
    ]);
  });

  test("columns the table no longer has are dropped; with nothing saved, the natural order", () => {
    expect(mergeColumnOrder(["gone", "b", "a"], ["a", "b"])).toEqual(["b", "a"]);
    expect(mergeColumnOrder([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    // a column with no predecessor placed goes first
    expect(mergeColumnOrder(["c"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("moving one place, and not past the ends", () => {
    expect(moveColumn(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveColumn(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveColumn(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveColumn(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });

  test("widths are clamped", () => {
    expect([clampWidth(10), clampWidth(123.6), clampWidth(5000)]).toEqual([60, 124, 800]);
  });
});

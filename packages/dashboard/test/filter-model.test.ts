import { describe, expect, test } from "bun:test";
import type { FilterExpression, IndexInfo } from "@bunvex/dashboard";
import {
  activeCount,
  addClause,
  addEq,
  emptyDraft,
  fromDraft,
  nextEqField,
  openRange,
  parseList,
  rangeField,
  removeEq,
  setIndex,
  toDraft,
  updateClause,
} from "../src/database/filter-model.ts";
import { encodeInt64 } from "../src/filters.ts";

const IX: IndexInfo = { name: "by_done_priority", fields: ["done", "priority"], system: false, state: "ready" };

describe("filter model", () => {
  test("an expression round-trips through the draft", () => {
    const expr: FilterExpression = {
      index: { name: IX.name, eq: [{ value: false, enabled: true }], range: { lower: { op: "gte", value: 2 } } },
      clauses: [
        { id: "a", field: "text", op: "eq", value: "Ship it", enabled: true },
        { id: "b", field: "tags", op: "anyOf", value: ["x", 2], enabled: true },
        { id: "c", field: "owner", op: "type", value: "unset", enabled: false },
        { id: "d", field: "credits", op: "gt", value: encodeInt64(5n), enabled: true },
      ],
      order: "asc",
    };
    const back = fromDraft(toDraft(expr));
    expect(back.errors).toEqual({});
    expect(back.expr).toEqual(expr);
    expect(fromDraft(emptyDraft()).expr).toEqual({ clauses: [], order: "desc" });
  });

  test("only valid index moves: a prefix, then a range on the next field", () => {
    let d = setIndex(emptyDraft(), IX.name);
    expect(nextEqField(d, IX)).toBe("done");
    d = addEq(d, IX);
    expect([nextEqField(d, IX), rangeField(d, IX)]).toEqual(["priority", "priority"]);
    d = addEq(addEq(addEq(d, IX), IX), IX); // no third field: stays at two
    expect(d.eq).toHaveLength(2);
    expect(rangeField(d, IX)).toBeUndefined();
    d = { ...removeEq(d, 0), range: { lower: { op: "gt", text: "1" } } };
    expect(d.eq).toHaveLength(0);
    expect(setIndex(d, "by_creation_time")).toMatchObject({ eq: [], range: {} });
  });

  test("errors name the part at fault, and only enabled parts block", () => {
    let d = addClause(emptyDraft(), "text", "eq", "[1,");
    const id = d.clauses[0]!.id;
    expect(Object.keys(fromDraft(d).errors)).toEqual([id]);
    d = updateClause(d, id, { enabled: false });
    expect(fromDraft(d).errors).toEqual({});
    expect(fromDraft(d).expr.clauses[0]).toMatchObject({ enabled: false });
    // a clause just added is silent (UX-2); once something is typed, the missing field is said
    const noField = addClause(emptyDraft());
    expect(fromDraft(noField).errors).toEqual({});
    expect(fromDraft(noField).expr.clauses[0]).toMatchObject({ enabled: false });
    const typed = updateClause(noField, noField.clauses[0]!.id, { text: '"x"' });
    expect(Object.values(fromDraft(typed).errors)).toEqual(["Pick a field"]);
    const badEq = addEq(setIndex(emptyDraft(), IX.name), IX);
    expect(Object.keys(fromDraft(badEq).errors)).toEqual(["eq.0"]);
  });

  test("switching between a value box and a type box clears the text", () => {
    let d = addClause(emptyDraft(), "text", "eq", "hello");
    const id = d.clauses[0]!.id;
    d = updateClause(d, id, { op: "neq" });
    expect(d.clauses[0]!.text).toBe("hello");
    d = updateClause(d, id, { op: "type" });
    expect(d.clauses[0]!.text).toBe("");
  });

  test("an open range with empty bounds is no range; a bound applies once typed", () => {
    let d = openRange(setIndex(emptyDraft(), "by_creation_time"));
    expect(fromDraft(d)).toEqual({ expr: { clauses: [], order: "desc" }, errors: {} }); // the default index, unbounded
    d = { ...d, range: { ...d.range, lower: { op: "gte", text: "100" } } };
    expect(fromDraft(d).expr.index?.range).toEqual({ lower: { op: "gte", value: 100 } });
  });

  test("lists: a literal list, with or without the brackets", () => {
    expect(parseList('["a", 1]')).toEqual({ ok: true, value: ["a", 1] });
    expect(parseList("'a', 1, true")).toEqual({ ok: true, value: ["a", 1, true] });
    expect(parseList("a, 1").ok).toBe(false); // text needs quotes
    expect(parseList("").ok).toBe(false);
    expect(parseList("a, [1").ok).toBe(false);
  });

  test("the active count", () => {
    const e = fromDraft(
      toDraft({
        index: { name: IX.name, eq: [{ value: true, enabled: true }], range: { upper: { op: "lt", value: 3 } } },
        clauses: [
          { id: "a", field: "x", op: "eq", value: 1, enabled: true },
          { id: "b", field: "y", op: "eq", value: 1, enabled: false },
        ],
        order: "desc",
      }),
    ).expr;
    expect(activeCount(e)).toBe(3);
  });
});

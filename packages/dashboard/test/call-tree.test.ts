import { describe, expect, test } from "bun:test";
import type { LogEntry } from "../src/data-source.ts";
import { callTree, countCalls } from "../src/logs/call-tree.ts";

let n = 0;
const line = (exec: string, over: Partial<LogEntry> = {}): LogEntry => {
  n++;
  return {
    id: String(n).padStart(4, "0"),
    time: n,
    level: "info",
    message: "m",
    requestId: "r",
    executionId: exec,
    function: { path: `m:${exec}`, kind: "query" },
    ...over,
  };
};
const done = (status: "success" | "failure", durationMs = 5) => ({ execution: { status, durationMs } });
const shape = (forest: ReturnType<typeof callTree>): unknown =>
  forest.map((c) => [c.executionId, c.status, shape(c.children)]);

describe("the functions a request called", () => {
  test("children under their caller, in the order they started; outcomes from the last line", () => {
    const lines = [
      line("a", { function: { path: "m:a", kind: "action" } }),
      line("c", { parentExecutionId: "a" }),
      line("b", { parentExecutionId: "a", ...done("failure") }),
      line("c", { parentExecutionId: "a", ...done("success") }),
      line("a", done("success", 90)),
    ];
    const forest = callTree([...lines].reverse()); // order of the input does not matter
    expect(shape(forest)).toEqual([
      [
        "a",
        "success",
        [
          ["c", "success", []],
          ["b", "failure", []],
        ],
      ],
    ]);
    expect(forest[0]!.durationMs).toBe(90);
    expect(countCalls(forest)).toBe(3);
  });

  test("no outcome yet is running; a caller not loaded puts its call at the top; lines without executions are left out", () => {
    const forest = callTree([
      line("x", { parentExecutionId: "gone" }),
      line("y"),
      line("", { executionId: undefined }),
    ]);
    expect(shape(forest)).toEqual([
      ["x", "running", []],
      ["y", "running", []],
    ]);
  });
});

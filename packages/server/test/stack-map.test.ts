// An error's stack as the app sees it (STUDY-95): a pushed module's frames mapped through its source map, the
// server's frames dropped, location-less frames kept only between the app's, and stacks with no pushed frame
// (functions registered in-process) untouched. The log's exception frames come from the same mapping.
import { expect, test } from "bun:test";
import { stackFrames } from "../src/log-events.ts";
import { SourceMapTokens } from "../src/source-position.ts";
import { mapStack, moduleUrl, registerModules } from "../src/stack-map.ts";

// messages.js's map: generated (0-based) line 0 col 0 → source 0 (../bunvex/messages.ts) line 0 col 0; generated
// line 1 col 4 → source 1 (../bunvex/lib/check.ts) line 2 col 2. A frame's position is 1-based.
const MAP = JSON.stringify({
  version: 3,
  sources: ["../bunvex/messages.ts", "../bunvex/lib/check.ts"],
  mappings: "AAAA;ICEEI",
  names: [],
});
const maps = new SourceMapTokens((path) => (path === "messages.js" ? MAP : undefined));
// The module's maps are kept alive by this test, as a code version's context keeps them.
const version = registerModules(maps);
const at = (path: string, line: number, col: number) => `${moduleUrl(version, path)}:${line}:${col}`;

test("a pushed module's frames are mapped; the server's are dropped; native ones kept between the app's", () => {
  const stack = [
    "Error: boom",
    `    at assertShort (${at("messages.js", 2, 6)})`,
    "    at map (native)",
    `    at ${at("messages.js", 1, 1)}`,
    "    at runQuery (/srv/packages/server/src/functions.ts:812:20)",
    "    at processTicksAndRejections (node:internal/process/task_queues:105:5)",
    "    at evaluate (unknown)",
  ].join("\n");
  expect(mapStack(stack)).toBe(
    [
      "Error: boom",
      "    at assertShort (../bunvex/lib/check.ts:3:3)",
      "    at map (native)",
      "    at ../bunvex/messages.ts:1:1",
    ].join("\n"),
  );
});

test("no map, or no token: the module's path; an unknown version: the module's path", () => {
  expect(mapStack(`E\n    at f (${at("other.js", 3, 4)})`)).toBe("E\n    at f (other.js:3:4)");
  expect(mapStack("E\n    at f (bunvex:/v999999/messages.js:2:6)")).toBe("E\n    at f (messages.js:2:6)");
});

test("a stack with no pushed module's frame is left as it is (functions registered in-process)", () => {
  const stack = "Error: x\n    at handler (/app/test/my.test.ts:10:3)\n    at run (/srv/functions.ts:1:1)";
  expect(mapStack(stack)).toBe(stack);
});

test("the log's exception frames are the mapped ones", () => {
  const frames = stackFrames(`Error: boom\n    at f (${at("messages.js", 2, 6)})\n    at g (/srv/engine.ts:1:1)`);
  expect(frames).toEqual([
    {
      functionName: "f",
      fileName: "../bunvex/lib/check.ts",
      lineNumber: 3,
      columnNumber: 3,
      text: "at f (../bunvex/lib/check.ts:3:3)",
    },
  ]);
});

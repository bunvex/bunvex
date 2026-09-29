import { expect, test } from "bun:test";
import { cn } from "@bunvex/ui/lib/utils";

test("cn joins conditional classes", () => {
  expect(cn("a", false && "b", undefined, ["c", { d: true, e: false }])).toBe("a c d");
});

test("cn lets a later utility override one of the same group", () => {
  expect(cn("px-2 py-1 text-sm", "px-4")).toBe("py-1 text-sm px-4");
});

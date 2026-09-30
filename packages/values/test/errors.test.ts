import { expect, test } from "bun:test";
import { BunvexError, isBunvexError } from "../src/index.ts";

test("BunvexError: data, name, and a message derived from the data (as Convex's ConvexError)", () => {
  const s = new BunvexError("sold out");
  expect(s).toBeInstanceOf(Error);
  expect(s.name).toBe("BunvexError");
  expect(s.message).toBe("sold out");
  expect(s.data).toBe("sold out");
  const o = new BunvexError({ code: 1, big: 2n });
  expect(o.message).toBe('{"code":1,"big":"2n"}');
  expect(o.data).toEqual({ code: 1, big: 2n });
});

test("isBunvexError recognises the class across copies of the package, by its registered symbol", () => {
  expect(isBunvexError(new BunvexError(null))).toBe(true);
  expect(isBunvexError(new Error("x"))).toBe(false);
  expect(isBunvexError("x")).toBe(false);
  const foreign = Object.assign(new Error("y"), { [Symbol.for("BunvexError")]: true, data: 1 });
  expect(isBunvexError(foreign)).toBe(true);
});

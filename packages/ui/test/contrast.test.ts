import { describe, expect, test } from "bun:test";
import { contrast, over, parseOklch, withAlpha } from "@bunvex/ui/lib/contrast";

describe("contrast", () => {
  test("black on white is 21:1, a colour on itself 1:1", () => {
    const white = parseOklch("oklch(1 0 0)");
    const black = parseOklch("oklch(0 0 0)");
    expect(contrast(black, white)).toBeCloseTo(21, 1);
    expect(contrast(white, white)).toBeCloseTo(1, 5);
  });

  test("OKLCH converts to the sRGB a browser shows", () => {
    // oklch(0.628 0.2577 29.23) is #ff0000; oklch(0.5 0 0) is about #636363
    const red = parseOklch("oklch(0.628 0.2577 29.23)");
    expect(red.r).toBeCloseTo(1, 2);
    expect(red.g).toBeCloseTo(0, 2);
    expect(red.b).toBeCloseTo(0, 2);
    expect(parseOklch("oklch(50% 0 0)").r * 255).toBeCloseTo(99, 0);
  });

  test("translucent colours composite over their backdrop", () => {
    const white = parseOklch("oklch(1 0 0)");
    const half = over(parseOklch("oklch(0 0 0 / 50%)"), white);
    expect(half.r).toBeCloseTo(0.5, 5);
    expect(over(withAlpha(parseOklch("oklch(0 0 0)"), 0.25), white).g).toBeCloseTo(0.75, 5);
  });

  test("rejects what it cannot parse", () => {
    expect(() => parseOklch("#fff")).toThrow("not an oklch()");
  });
});

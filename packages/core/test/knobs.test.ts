// STUDY-147: knobs from the environment, as Convex's `env_config` (crates/cmd_util/src/env.rs): unset gives
// the default; a value that does not parse as the knob's type is logged and gives the default, never an error;
// a value other than the default is logged as an override; each line is logged once.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { boolKnob, knob, secondsKnob } from "../src/knobs.ts";

const lines: { level: "info" | "warn"; line: string }[] = [];
const saved = { info: console.info, warn: console.warn };
beforeEach(() => {
  lines.length = 0;
  console.info = (line: string) => lines.push({ level: "info", line });
  console.warn = (line: string) => lines.push({ level: "warn", line });
});
afterEach(() => {
  console.info = saved.info;
  console.warn = saved.warn;
});

test("unset: the default, nothing logged", () => {
  expect(knob("K_UNSET", 7, "uint", {})).toBe(7);
  expect(boolKnob("K_UNSET", true, {})).toBe(true);
  expect(secondsKnob("K_UNSET", 3, {})).toBe(3000);
  expect(lines).toEqual([]);
});

test("unsigned integers as Rust's `usize::from_str`: digits, a leading +; else the default", () => {
  const n = (raw: string) => knob("K_UINT", 7, "uint", { K_UINT: raw });
  expect(n("12")).toBe(12);
  expect(n("+12")).toBe(12);
  expect(n("0")).toBe(0);
  expect(n("007")).toBe(7);
  for (const bad of ["", " 12", "12 ", "-1", "1.5", "1e3", "0x10", "abc", "9007199254740993"]) expect(n(bad)).toBe(7);
  expect(lines.filter((l) => l.level === "warn").map((l) => l.line)).toContain(
    "Invalid value -1 for K_UINT, falling back to 7.",
  );
});

test("non-zero integers refuse 0, as `NonZeroU32`", () => {
  expect(knob("K_POS", 16, "positive", { K_POS: "0" })).toBe(16);
  expect(knob("K_POS", 16, "positive", { K_POS: "3" })).toBe(3);
});

test("floats as `f64::from_str`: decimals, exponents, signs, inf and NaN", () => {
  const f = (raw: string) => knob("K_FLOAT", 0.8, "float", { K_FLOAT: raw });
  expect(f("0.5")).toBe(0.5);
  expect(f("1e3")).toBe(1000);
  expect(f(".5")).toBe(0.5);
  expect(f("-2")).toBe(-2);
  expect(f("inf")).toBe(Number.POSITIVE_INFINITY);
  expect(f("NaN")).toBeNaN();
  for (const bad of ["", "half", "1,5", " 1"]) expect(f(bad)).toBe(0.8);
});

test("booleans: exactly `true` or `false`, as `bool::from_str`", () => {
  const b = (raw: string) => boolKnob("K_BOOL", false, { K_BOOL: raw });
  expect(b("true")).toBe(true);
  expect(b("false")).toBe(false);
  for (const bad of ["TRUE", "1", "yes", ""]) expect(b(bad)).toBe(false);
});

test("seconds become milliseconds", () => {
  expect(secondsKnob("K_SECS", 60, { K_SECS: "2" })).toBe(2000);
  expect(secondsKnob("K_SECS", 60, { K_SECS: "x" })).toBe(60_000);
});

test("an override is logged as Convex's, once however often the knob is read", () => {
  for (let i = 0; i < 3; i++) knob("K_ONCE", 1, "uint", { K_ONCE: "5" });
  knob("K_SAME", 1, "uint", { K_SAME: "1" });
  for (let i = 0; i < 3; i++) knob("K_BAD", 1, "uint", { K_BAD: "x" });
  expect(lines).toEqual([
    { level: "info", line: "Overriding K_ONCE to 5 from environment" },
    { level: "warn", line: "Invalid value x for K_BAD, falling back to 1." },
  ]);
});

// A float64 as Convex's messages print it. Convex shows a value with `Display for ConvexValue`
// (crates/value/src/lib.rs), whose float64 arm is Rust's `{:?}` (`float_to_general_debug` in core::fmt::float):
//
// - the shortest digits that round-trip (JavaScript's `toExponential()` gives the same digits);
// - plain decimal for 0 and for 1e-4 <= |x| < 1e16, always with a fractional part (`1.0`, `0.0001`);
// - otherwise scientific, with no `+` and no fractional part when there is one digit (`1e16`, `1.5e-7`);
// - `NaN`, `inf`, `-inf`, and `-0.0` for negative zero.
//
// Checked against Rust itself (packages/values/test/float-text.test.ts and its fixture).

const view = new DataView(new ArrayBuffer(8));

/** |x| exactly, as `mantissa × 2^exponent`. */
function binary(abs: number): { mantissa: bigint; exponent: bigint } {
  view.setFloat64(0, abs);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  return biased === 0
    ? { mantissa: fraction, exponent: -1074n }
    : { mantissa: fraction | (1n << 52n), exponent: BigInt(biased - 1075) };
}

/** Whether |x| is exactly halfway between `digits` and `digits + 1` in units of 10^`unit`. */
function isTie(abs: number, digits: bigint, unit: number): boolean {
  // 2·|x| = (2·digits + 1)·10^unit, both sides scaled to integers.
  const { mantissa, exponent } = binary(abs);
  let left = 2n * mantissa;
  let right = 2n * digits + 1n;
  if (exponent >= 0n) left <<= exponent;
  else right <<= -exponent;
  if (unit >= 0) right *= 10n ** BigInt(unit);
  else left *= 10n ** BigInt(-unit);
  return left === right;
}

/**
 * The shortest round-trip digits of a finite non-zero |x|, and the exponent of the first one. JavaScript breaks
 * an exact tie between two shortest candidates towards the even one; Rust's `{:?}` takes the upper one.
 */
function shortest(abs: number): { digits: string; exponent: number } {
  const [mantissa, exponentText] = abs.toExponential().split("e") as [string, string];
  let digits = mantissa.replace(".", "");
  let exponent = Number(exponentText);
  const unit = exponent - digits.length + 1;
  // Two candidates can both round-trip only when a step in the last digit is about a double's spacing: with 15
  // digits or fewer, 10^unit is far wider than it, so no tie is possible and the exact check is skipped.
  if (digits.length >= 16 && isTie(abs, BigInt(digits), unit)) {
    const up = (BigInt(digits) + 1n).toString();
    if (Number(`${up}e${unit}`) === abs) {
      // `…9` + 1 carries into a new digit: one more leading digit, then trailing zeros to drop.
      if (up.length > digits.length) exponent += 1;
      digits = up.replace(/0+$/, "") || "0";
    }
  }
  return { digits, exponent };
}

/** Rust's `{:?}` for an f64, as Convex prints a float64 value in messages. */
export function floatDebugText(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Number.POSITIVE_INFINITY) return "inf";
  if (x === Number.NEGATIVE_INFINITY) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const abs = Math.abs(x);
  const { digits, exponent } = shortest(abs);
  if (abs < 1e-4 || abs >= 1e16)
    return `${sign}${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ""}e${exponent}`;
  // Plain decimal: the point goes after `exponent + 1` digits.
  const point = exponent + 1;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

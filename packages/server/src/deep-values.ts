// Values too deep to stringify (STUDY-109): in Bun (JSC), a `JSON.stringify` that overflows the stack takes about
// 1.6 s to throw, whatever the depth past the overflow (~50 000 levels), so a 200 KB argument of nested arrays cost
// a request that long. Such a value is past the nesting limit (64) many times over and refused anyway; this finds it
// first, without recursion, stopping at the first level past the bound. Each root is walked once (sync measures,
// keys and converts the same arguments).

/** Far above the nesting limit (64), so every message up to it is unchanged; far below a stack overflow. */
export const STRINGIFY_SAFE_DEPTH = 1000;

const verdicts = new WeakMap<object, boolean>();

/** Whether `value` nests deeper than `STRINGIFY_SAFE_DEPTH` (arrays and objects). */
export function tooDeepToStringify(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const known = verdicts.get(value);
  if (known !== undefined) return known;
  const stack: unknown[] = [value];
  const depths: number[] = [1];
  let deep = false;
  while (stack.length > 0) {
    const v = stack.pop();
    const d = depths.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (d > STRINGIFY_SAFE_DEPTH) {
      deep = true;
      break;
    }
    if (Array.isArray(v))
      for (let i = 0; i < v.length; i++) {
        stack.push(v[i]);
        depths.push(d + 1);
      }
    else
      for (const k in v) {
        stack.push((v as Record<string, unknown>)[k]);
        depths.push(d + 1);
      }
  }
  verdicts.set(value, deep);
  return deep;
}

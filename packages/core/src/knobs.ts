// Tuning knobs from the environment, as Convex's `env_config` (crates/cmd_util/src/env.rs) reads those of
// crates/common/src/knobs.rs (STUDY-147): under Convex's names, read once (at module load for a constant, at
// construction otherwise). An unset variable gives the default; a value that does not parse is logged and the
// default used, never an error; a value other than the default is logged, once, as Convex's "Overriding".

/** Where knobs are read from: `process.env`, or a test's own record. */
export type KnobEnv = Record<string, string | undefined>;

/**
 * How a knob's text parses, as Rust's `FromStr` for the knob's type: `uint` an unsigned integer (`usize`,
 * `u32`, `u64`; a leading `+` allowed), `positive` a non-zero one (`NonZeroU32`, `NonZeroUsize`), `float` an
 * `f64`.
 */
export type KnobKind = "uint" | "positive" | "float";

const UINT = /^\+?[0-9]+$/;
const FLOAT = /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$|^[+-]?(inf|infinity|nan)$/i;

/** A knob's text as `kind`, or `undefined` when it does not parse (for a setting that refuses it instead). */
export function parseKnob(raw: string, kind: KnobKind): number | undefined {
  if (kind === "float") {
    if (!FLOAT.test(raw)) return undefined;
    const t = raw.toLowerCase().replace(/^\+/, "");
    if (t === "inf" || t === "infinity") return Number.POSITIVE_INFINITY;
    if (t === "-inf" || t === "-infinity") return Number.NEGATIVE_INFINITY;
    if (t.endsWith("nan")) return Number.NaN;
    return Number(raw);
  }
  if (!UINT.test(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return undefined;
  if (kind === "positive" && n === 0) return undefined;
  return n;
}

/** What was logged already: a knob read again (one per engine, say) logs once, as Convex's `LazyLock`. */
const logged = new Set<string>();
const once = (line: string, log: (line: string) => void) => {
  if (logged.has(line)) return;
  logged.add(line);
  log(line);
};

function fromEnv<T>(name: string, def: T, env: KnobEnv, read: (raw: string) => T | undefined): T {
  const raw = env[name];
  if (raw === undefined) return def;
  const v = read(raw);
  if (v === undefined) {
    once(`Invalid value ${raw} for ${name}, falling back to ${String(def)}.`, console.warn);
    return def;
  }
  if (!Object.is(v, def)) once(`Overriding ${name} to ${String(v)} from environment`, console.info);
  return v;
}

/** A numeric knob: `name` from `env` when it parses as `kind`, else `def`. */
export function knob(name: string, def: number, kind: KnobKind = "uint", env: KnobEnv = process.env): number {
  return fromEnv(name, def, env, (raw) => parseKnob(raw, kind));
}

/** A boolean knob: exactly `true` or `false`, as Rust's `bool::from_str`. */
export function boolKnob(name: string, def: boolean, env: KnobEnv = process.env): boolean {
  return fromEnv(name, def, env, (raw) => (raw === "true" ? true : raw === "false" ? false : undefined));
}

/** A duration knob given in seconds (Convex's `Duration::from_secs(env_config(…))`), in milliseconds. */
export const secondsKnob = (name: string, defSeconds: number, env: KnobEnv = process.env): number =>
  knob(name, defSeconds, "uint", env) * 1000;

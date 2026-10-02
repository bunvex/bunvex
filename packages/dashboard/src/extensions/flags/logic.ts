// Feature flags, the pure part (UI-01 §28): which variant an identity gets, whether a flag is valid, and how
// a rule reads in words. The mock evaluates with it; the screen previews with it ("who gets what").

import type { Json } from "../../data-source.ts";
import type { FeatureFlag, FlagCondition, FlagInput, FlagRollout, FlagRule } from "./types.ts";

/** An identity's attributes, as the caller's token carries them (subject, email, org, custom claims). */
export type FlagIdentity = Record<string, string | undefined>;

/** A stable bucket in [0, 100) for this identity and flag: the same identity always lands in the same place. */
export function bucketOf(flagKey: string, identity: FlagIdentity): number {
  const id = identity.tokenIdentifier ?? identity.subject ?? identity.email ?? "anonymous";
  let h = 2166136261;
  for (const ch of `${flagKey}:${id}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return (h % 10_000) / 100;
}

/** The variant a rollout gives to a bucket: the weights in order, cumulatively. */
export function pickFromRollout(rollout: FlagRollout, bucket: number): string {
  let acc = 0;
  for (const r of rollout) {
    acc += r.weight;
    if (bucket < acc) return r.variant;
  }
  return rollout.at(-1)?.variant ?? "";
}

export function matches(c: FlagCondition, identity: FlagIdentity): boolean {
  const v = identity[c.attribute];
  switch (c.operator) {
    case "exists":
      return v !== undefined && v !== "";
    case "equals":
      return v !== undefined && v === c.values[0];
    case "notEquals":
      return v !== c.values[0];
    case "in":
      return v !== undefined && c.values.includes(v);
    case "notIn":
      return v === undefined || !c.values.includes(v);
    case "contains":
      return v !== undefined && c.values.some((x) => v.includes(x));
    case "startsWith":
      return v !== undefined && c.values.some((x) => v.startsWith(x));
    case "endsWith":
      return v !== undefined && c.values.some((x) => v.endsWith(x));
  }
}

export type Evaluation = { variant: string; value: Json; reason: "off" | "rule" | "fallthrough"; ruleId?: string };

/** What a flag serves to an identity: off → the off variant; else the first matching rule; else the fallthrough. */
export function evaluate(
  flag: Pick<FeatureFlag, "key" | "enabled" | "variants" | "offVariant" | "rules" | "fallthrough">,
  identity: FlagIdentity,
): Evaluation {
  const valueFor = (key: string) => flag.variants.find((v) => v.key === key)?.value ?? null;
  if (!flag.enabled) return { variant: flag.offVariant, value: valueFor(flag.offVariant), reason: "off" };
  const bucket = bucketOf(flag.key, identity);
  const serve = (s: FlagRule["serve"]) => ("variant" in s ? s.variant : pickFromRollout(s.rollout, bucket));
  for (const rule of flag.rules)
    if (rule.conditions.every((c) => matches(c, identity))) {
      const variant = serve(rule.serve);
      return { variant, value: valueFor(variant), reason: "rule", ruleId: rule.id };
    }
  const variant = serve(flag.fallthrough);
  return { variant, value: valueFor(variant), reason: "fallthrough" };
}

/** A flag key: lowercase letters, digits, "-", "_" and ".", starting with a letter. */
export const KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

/** Why a flag cannot be saved, or nothing. The first problem only, said as the editor shows it. */
export function flagProblem(f: FlagInput, existingKeys: readonly string[] = []): string | undefined {
  if (!KEY_PATTERN.test(f.key))
    return "The key starts with a letter and has only lowercase letters, digits, -, _ and . (up to 64).";
  if (existingKeys.includes(f.key)) return `A flag "${f.key}" already exists.`;
  if (!f.name.trim()) return "Give the flag a name.";
  if (f.variants.length < 2) return "A flag needs at least two variants.";
  const keys = f.variants.map((v) => v.key);
  if (keys.some((k) => !k.trim())) return "Every variant needs a key.";
  if (new Set(keys).size !== keys.length) return "Two variants have the same key.";
  if (f.type === "boolean" && !f.variants.every((v) => typeof v.value === "boolean"))
    return "A boolean flag's variants are true and false.";
  const known = (k: string) => keys.includes(k);
  if (!known(f.offVariant)) return `The off variant "${f.offVariant}" is not one of the variants.`;
  const checkServe = (s: FlagRule["serve"], where: string): string | undefined => {
    if ("variant" in s) return known(s.variant) ? undefined : `${where} serves "${s.variant}", which is not a variant.`;
    if (s.rollout.some((r) => !known(r.variant))) return `${where}'s rollout names a variant that does not exist.`;
    if (s.rollout.some((r) => r.weight < 0 || !Number.isFinite(r.weight)))
      return `${where}'s rollout has a negative share.`;
    const total = s.rollout.reduce((n, r) => n + r.weight, 0);
    if (Math.abs(total - 100) > 1e-9) return `${where}'s rollout adds up to ${total} %, not 100 %.`;
    return undefined;
  };
  for (const [i, r] of f.rules.entries()) {
    if (r.conditions.length === 0) return `Rule ${i + 1} has no condition.`;
    for (const c of r.conditions) {
      if (!c.attribute.trim()) return `Rule ${i + 1} has a condition without an attribute.`;
      if (c.operator !== "exists" && c.values.length === 0) return `Rule ${i + 1} has a condition without a value.`;
    }
    const p = checkServe(r.serve, `Rule ${i + 1}`);
    if (p) return p;
  }
  return checkServe(f.fallthrough, "The default");
}

const OPERATOR_WORDS: Record<FlagCondition["operator"], string> = {
  equals: "is",
  notEquals: "is not",
  in: "is one of",
  notIn: "is not one of",
  contains: "contains",
  startsWith: "starts with",
  endsWith: "ends with",
  exists: "is set",
};

export function conditionText(c: FlagCondition): string {
  if (c.operator === "exists") return `${c.attribute} is set`;
  const vs = c.values.map((v) => `"${v}"`).join(", ");
  return `${c.attribute} ${OPERATOR_WORDS[c.operator]} ${vs}`;
}

export function serveText(s: FlagRule["serve"]): string {
  if ("variant" in s) return s.variant;
  return s.rollout.map((r) => `${r.variant} ${r.weight} %`).join(" · ");
}

/** "If email ends with "@acme.com" and plan is "pro", serve on". */
export function ruleText(r: FlagRule): string {
  return `If ${r.conditions.map(conditionText).join(" and ")}, serve ${serveText(r.serve)}`;
}

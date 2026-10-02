// A flag's editor (UI-01 §28), in the details panel: its key (new flags only), name and type; its variants
// (fixed true/false for a boolean flag; names for variants; names and JavaScript-literal values for JSON);
// the variant served when off; the default — one variant or a rollout by percentage; and the targeting
// rules, in order, each a set of conditions on the identity serving a variant. Checked as it is typed; the
// source checks again on save.
import { Button } from "@bunvex/ui/components/button";
import { Input } from "@bunvex/ui/components/input";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useId, useState } from "react";
import { useQueryScope } from "../../context.tsx";
import { type Json, toDataSourceError } from "../../data-source.ts";
import { formatLiteral, parseLiteral, UNSET } from "../../database/literal.ts";
import { flagProblem } from "./logic.ts";
import { flagsKey } from "./screen.tsx";
import {
  type FeatureFlag,
  FLAG_OPERATORS,
  type FlagInput,
  type FlagOperator,
  type FlagRule,
  type FlagType,
} from "./types.ts";

type DraftVariant = { key: string; valueText: string };
type DraftRule = {
  id: string;
  conditions: { attribute: string; operator: FlagOperator; values: string }[];
  variant: string;
};
type Draft = {
  key: string;
  name: string;
  description: string;
  type: FlagType;
  enabled: boolean;
  variants: DraftVariant[];
  offVariant: string;
  mode: "variant" | "rollout";
  variant: string;
  weights: Record<string, string>;
  rules: DraftRule[];
};

const BOOLEAN_VARIANTS: DraftVariant[] = [
  { key: "on", valueText: "true" },
  { key: "off", valueText: "false" },
];

function draftOf(f?: FeatureFlag): Draft {
  if (!f)
    return {
      key: "",
      name: "",
      description: "",
      type: "boolean",
      enabled: false,
      variants: BOOLEAN_VARIANTS,
      offVariant: "off",
      mode: "rollout",
      variant: "on",
      weights: { on: "10", off: "90" },
      rules: [],
    };
  const rollout = "rollout" in f.fallthrough ? f.fallthrough.rollout : [];
  return {
    key: f.key,
    name: f.name,
    description: f.description ?? "",
    type: f.type,
    enabled: f.enabled,
    variants: f.variants.map((v) => ({ key: v.key, valueText: formatLiteral(v.value) })),
    offVariant: f.offVariant,
    mode: "variant" in f.fallthrough ? "variant" : "rollout",
    variant: "variant" in f.fallthrough ? f.fallthrough.variant : (rollout[0]?.variant ?? ""),
    weights: Object.fromEntries(rollout.map((r) => [r.variant, String(r.weight)])),
    rules: f.rules.map((r) => ({
      id: r.id,
      conditions: r.conditions.map((c) => ({ ...c, values: c.values.join(", ") })),
      variant: "variant" in r.serve ? r.serve.variant : (r.serve.rollout[0]?.variant ?? ""),
    })),
  };
}

/** A variant's value from its text: the key itself for "variant" flags; a literal otherwise. */
function variantValue(type: FlagType, v: DraftVariant): { value: Json } | { error: string } {
  if (type === "variant") return { value: v.key };
  const r = parseLiteral(v.valueText);
  if (!r.ok) return { error: `The value of "${v.key}": ${r.error}` };
  if (r.value === UNSET) return { error: `The value of "${v.key}" is undefined.` };
  // a JSON value: no int64 or bytes
  const json = JSON.stringify(r.value);
  if (json.includes('"$integer"') || json.includes('"$bytes"'))
    return { error: `The value of "${v.key}" must be JSON (no 10n, no Bytes).` };
  return { value: r.value as Json };
}

/** The draft as a flag, or why it is not one yet. */
function inputOf(d: Draft): { flag: FlagInput } | { error: string } {
  const variants: FlagInput["variants"] = [];
  for (const v of d.variants) {
    const r = variantValue(d.type, v);
    if ("error" in r) return r;
    variants.push({ key: v.key.trim(), value: r.value });
  }
  const weights = d.variants.map((v) => ({ variant: v.key.trim(), weight: Number(d.weights[v.key] ?? 0) }));
  return {
    flag: {
      key: d.key.trim(),
      name: d.name.trim(),
      ...(d.description.trim() && { description: d.description.trim() }),
      type: d.type,
      enabled: d.enabled,
      variants,
      offVariant: d.offVariant,
      fallthrough:
        d.mode === "variant"
          ? { variant: d.variant }
          : { rollout: weights.filter((w) => w.weight > 0 || weights.length <= 2) },
      rules: d.rules.map(
        (r): FlagRule => ({
          id: r.id,
          conditions: r.conditions.map((c) => ({
            attribute: c.attribute.trim(),
            operator: c.operator,
            values:
              c.operator === "exists"
                ? []
                : c.values
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
          })),
          serve: { variant: r.variant },
        }),
      ),
    },
  };
}

export function FlagEditor(props: {
  flag?: FeatureFlag;
  existingKeys: readonly string[];
  onDone: (savedKey?: string) => void;
}) {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const [d, setD] = useState<Draft>(() => draftOf(props.flag));
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string>();
  const ids = { key: useId(), name: useId(), description: useId(), type: useId(), off: useId(), problem: useId() };
  const isNew = !props.flag;
  const built = inputOf(d);
  const problem = "error" in built ? built.error : flagProblem(built.flag, isNew ? props.existingKeys : []);
  const update = (patch: Partial<Draft>) => {
    setD((x) => ({ ...x, ...patch }));
    setRefused(undefined);
  };
  const keys = d.variants.map((v) => v.key);

  const save = async () => {
    if (problem || "error" in built) return;
    setSaving(true);
    try {
      await scope.source.saveFlag!(built.flag);
      await queryClient.invalidateQueries({ queryKey: flagsKey(scope.scope) });
      props.onDone(built.flag.key);
    } catch (e) {
      setRefused(toDataSourceError(e).message);
      setSaving(false);
    }
  };

  const field = "flex flex-col gap-1";
  const label = "text-xs font-medium";
  return (
    <form
      className="flex flex-col gap-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {isNew && (
        <div className={field}>
          <label htmlFor={ids.key} className={label}>
            Key
          </label>
          <Input
            id={ids.key}
            className="font-mono"
            placeholder="new-checkout"
            value={d.key}
            onChange={(e) => update({ key: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">What code reads. It cannot change later.</p>
        </div>
      )}
      <div className={field}>
        <label htmlFor={ids.name} className={label}>
          Name
        </label>
        <Input id={ids.name} value={d.name} onChange={(e) => update({ name: e.target.value })} />
      </div>
      <div className={field}>
        <label htmlFor={ids.description} className={label}>
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <Input id={ids.description} value={d.description} onChange={(e) => update({ description: e.target.value })} />
      </div>
      <div className={field}>
        <label htmlFor={ids.type} className={label}>
          Type
        </label>
        <select
          id={ids.type}
          className="h-8 border bg-background px-2"
          value={d.type}
          disabled={!isNew}
          onChange={(e) => {
            const type = e.target.value as FlagType;
            const variants =
              type === "boolean"
                ? BOOLEAN_VARIANTS
                : type === "variant"
                  ? [
                      { key: "control", valueText: "" },
                      { key: "treatment", valueText: "" },
                    ]
                  : [
                      { key: "none", valueText: "null" },
                      { key: "config", valueText: "{ enabled: true }" },
                    ];
            update({
              type,
              variants,
              offVariant: variants[0]!.key === "on" ? "off" : variants[0]!.key,
              variant: variants[0]!.key,
              weights: Object.fromEntries(variants.map((v, i) => [v.key, i === 0 ? "100" : "0"])),
              rules: [],
            });
          }}
        >
          <option value="boolean">Boolean (on / off)</option>
          <option value="variant">Variants (named)</option>
          <option value="json">JSON (a value per variant)</option>
        </select>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className={label}>Variants</legend>
        {d.variants.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a variant is identified by its row while edited
          <div key={i} className="flex items-center gap-2">
            <Input
              aria-label={`Variant ${i + 1} key`}
              className="w-36 font-mono"
              value={v.key}
              disabled={d.type === "boolean"}
              onChange={(e) =>
                update({ variants: d.variants.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })
              }
            />
            {d.type === "json" && (
              <Input
                aria-label={`Variant ${i + 1} value`}
                className="min-w-0 flex-1 font-mono"
                value={v.valueText}
                onChange={(e) =>
                  update({ variants: d.variants.map((x, j) => (j === i ? { ...x, valueText: e.target.value } : x)) })
                }
              />
            )}
            {d.type === "boolean" && <code className="font-mono text-xs text-muted-foreground">{v.valueText}</code>}
            {d.type !== "boolean" && d.variants.length > 2 && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove variant ${v.key || i + 1}`}
                onClick={() => update({ variants: d.variants.filter((_, j) => j !== i) })}
              >
                <X aria-hidden="true" />
              </Button>
            )}
          </div>
        ))}
        {d.type !== "boolean" && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() =>
              update({ variants: [...d.variants, { key: `variant-${d.variants.length + 1}`, valueText: "null" }] })
            }
          >
            <Plus aria-hidden="true" />
            Add a variant
          </Button>
        )}
      </fieldset>

      <div className={field}>
        <label htmlFor={ids.off} className={label}>
          When off, serve
        </label>
        <select
          id={ids.off}
          className="h-8 border bg-background px-2 font-mono text-xs"
          value={d.offVariant}
          onChange={(e) => update({ offVariant: e.target.value })}
        >
          {keys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className={label}>When on, by default serve</legend>
        <div className="flex gap-4">
          {(["variant", "rollout"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1.5">
              <input type="radio" name="flag-mode" checked={d.mode === m} onChange={() => update({ mode: m })} />
              {m === "variant" ? "One variant" : "A percentage rollout"}
            </label>
          ))}
        </div>
        {d.mode === "variant" ? (
          <select
            aria-label="The default variant"
            className="h-8 border bg-background px-2 font-mono text-xs"
            value={d.variant}
            onChange={(e) => update({ variant: e.target.value })}
          >
            {keys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        ) : (
          <div className="flex flex-col gap-1">
            {keys.map((k) => (
              <div key={k} className="flex items-center gap-2">
                <span className="w-36 truncate font-mono text-xs">{k}</span>
                <Input
                  aria-label={`Share of ${k} (%)`}
                  type="number"
                  min={0}
                  max={100}
                  className="w-24"
                  value={d.weights[k] ?? "0"}
                  onChange={(e) => update({ weights: { ...d.weights, [k]: e.target.value } })}
                />
                <span className="text-xs text-muted-foreground">%</span>
              </div>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className={label}>Targeting rules, in order (the first that matches serves)</legend>
        {d.rules.map((r, ri) => (
          <div key={r.id} className="flex flex-col gap-2 border p-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Rule {ri + 1}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove rule ${ri + 1}`}
                onClick={() => update({ rules: d.rules.filter((_, j) => j !== ri) })}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            {r.conditions.map((c, ci) => {
              const set = (patch: Partial<typeof c>) =>
                update({
                  rules: d.rules.map((x, j) =>
                    j === ri
                      ? { ...x, conditions: x.conditions.map((y, k) => (k === ci ? { ...y, ...patch } : y)) }
                      : x,
                  ),
                });
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a condition is identified by its row while edited
                <div key={ci} className="flex flex-wrap items-center gap-1">
                  <Input
                    aria-label={`Rule ${ri + 1} condition ${ci + 1} attribute`}
                    className="w-28 font-mono"
                    placeholder="email"
                    value={c.attribute}
                    onChange={(e) => set({ attribute: e.target.value })}
                  />
                  <select
                    aria-label={`Rule ${ri + 1} condition ${ci + 1} operator`}
                    className="h-8 border bg-background px-1 text-xs"
                    value={c.operator}
                    onChange={(e) => set({ operator: e.target.value as FlagOperator })}
                  >
                    {FLAG_OPERATORS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                  {c.operator !== "exists" && (
                    <Input
                      aria-label={`Rule ${ri + 1} condition ${ci + 1} values`}
                      className="min-w-0 flex-1"
                      placeholder="@acme.com, @globex.com"
                      value={c.values}
                      onChange={(e) => set({ values: e.target.value })}
                    />
                  )}
                </div>
              );
            })}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  update({
                    rules: d.rules.map((x, j) =>
                      j === ri
                        ? { ...x, conditions: [...x.conditions, { attribute: "", operator: "equals", values: "" }] }
                        : x,
                    ),
                  })
                }
              >
                <Plus aria-hidden="true" />
                And…
              </Button>
              <span className="ml-auto text-xs">serve</span>
              <select
                aria-label={`Rule ${ri + 1} serves`}
                className="h-8 border bg-background px-2 font-mono text-xs"
                value={r.variant}
                onChange={(e) =>
                  update({ rules: d.rules.map((x, j) => (j === ri ? { ...x, variant: e.target.value } : x)) })
                }
              >
                {keys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() =>
            update({
              rules: [
                ...d.rules,
                {
                  id: `r${Date.now().toString(36)}`,
                  conditions: [{ attribute: "email", operator: "endsWith", values: "" }],
                  variant: keys[0] ?? "",
                },
              ],
            })
          }
        >
          <Plus aria-hidden="true" />
          Add a rule
        </Button>
      </fieldset>

      {isNew && (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={d.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          Turn it on now
        </label>
      )}

      <p id={ids.problem} className="min-h-5 text-xs text-destructive" aria-live="polite">
        {problem}
      </p>
      {refused && (
        <p role="alert" className="text-xs text-destructive">
          {refused}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={!!problem || saving}
          aria-describedby={problem ? ids.problem : undefined}
        >
          {saving ? "Saving…" : isNew ? "Create flag" : "Save changes"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => props.onDone()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

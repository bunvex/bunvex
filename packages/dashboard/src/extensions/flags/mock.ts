// The mock's feature flags (UI-01 §28): a handful of realistic flags — a rollout, an A/B/C test, a JSON
// config, a targeted rule, an archived one — their history, and exposures that follow each flag's rollout.
// Writes need a credential that can write; every change is in the flag's history and the audit log.
import { DataSourceError, type MetricsWindow } from "../../data-source.ts";
import type { MockContext, MockExtensionPart } from "../mock-types.ts";
import { flagProblem } from "./logic.ts";
import type { FeatureFlag, FlagChange, FlagChangeAction, FlagExposures, FlagInput, FlagRollout } from "./types.ts";

const DAY = 86_400_000;
const ADMIN = "admin key";

function seedFlags(now: number): FeatureFlag[] {
  const bool = (on: boolean) => ({ key: on ? "on" : "off", value: on });
  const base = { archived: false, updatedBy: ADMIN };
  return [
    {
      ...base,
      key: "new-dashboard",
      name: "New dashboard",
      description: "The redesigned home screen, rolled out gradually.",
      type: "boolean",
      enabled: true,
      variants: [bool(true), bool(false)],
      offVariant: "off",
      rules: [
        {
          id: "r1",
          description: "Staff always see it",
          conditions: [{ attribute: "email", operator: "endsWith", values: ["@bunvex.dev"] }],
          serve: { variant: "on" },
        },
      ],
      fallthrough: {
        rollout: [
          { variant: "on", weight: 25 },
          { variant: "off", weight: 75 },
        ],
      },
      createdAt: now - 21 * DAY,
      updatedAt: now - 2 * DAY,
    },
    {
      ...base,
      key: "checkout-flow",
      name: "Checkout flow test",
      description: "A/B/C test of the checkout steps.",
      type: "variant",
      enabled: true,
      variants: [
        { key: "control", value: "control", description: "Today's three steps" },
        { key: "one-page", value: "one-page" },
        { key: "express", value: "express" },
      ],
      offVariant: "control",
      rules: [
        {
          id: "r_mobile",
          description: "The new app builds get express checkout",
          conditions: [
            { attribute: "platform", operator: "in", values: ["ios", "android"] },
            { attribute: "appVersion", operator: "versionAtLeast", values: ["2.3.0"] },
          ],
          serve: { variant: "express" },
        },
      ],
      fallthrough: {
        rollout: [
          { variant: "control", weight: 50 },
          { variant: "one-page", weight: 25 },
          { variant: "express", weight: 25 },
        ],
      },
      createdAt: now - 9 * DAY,
      updatedAt: now - 9 * DAY,
    },
    {
      ...base,
      key: "pricing-banner",
      name: "Pricing banner",
      description: "The promotion shown above the pricing table.",
      type: "json",
      enabled: false,
      variants: [
        { key: "none", value: null },
        { key: "launch", value: { text: "Launch week: 30 % off", tone: "info" } },
      ],
      offVariant: "none",
      rules: [],
      fallthrough: { variant: "launch" },
      createdAt: now - 30 * DAY,
      updatedAt: now - 5 * DAY,
    },
    {
      ...base,
      key: "search-engine",
      name: "Search engine",
      type: "variant",
      enabled: true,
      variants: [
        { key: "builtin", value: "builtin" },
        { key: "vector", value: "vector" },
      ],
      offVariant: "builtin",
      rules: [
        {
          id: "r1",
          conditions: [{ attribute: "org", operator: "in", values: ["acme", "globex"] }],
          serve: { variant: "vector" },
        },
      ],
      fallthrough: { variant: "builtin" },
      createdAt: now - 14 * DAY,
      updatedAt: now - 1 * DAY,
    },
    {
      ...base,
      key: "legacy-export",
      name: "Legacy CSV export",
      type: "boolean",
      enabled: false,
      variants: [bool(true), bool(false)],
      offVariant: "off",
      rules: [],
      fallthrough: { variant: "on" },
      archived: true,
      createdAt: now - 90 * DAY,
      updatedAt: now - 40 * DAY,
    },
  ];
}

/** Each variant's share of what the flag serves (rules ignored: they cover few identities). */
function shares(f: FeatureFlag): Map<string, number> {
  if (!f.enabled) return new Map([[f.offVariant, 1]]);
  const roll: FlagRollout =
    "variant" in f.fallthrough ? [{ variant: f.fallthrough.variant, weight: 100 }] : f.fallthrough.rollout;
  return new Map(roll.map((r) => [r.variant, r.weight / 100]));
}

export const flagsMock: MockExtensionPart = {
  id: "flags",
  create: (ctx: MockContext) => {
    const start = ctx.now();
    const flags = new Map(seedFlags(start).map((f) => [f.key, f]));
    const history = new Map<string, FlagChange[]>();
    let seq = 0;
    const log = (key: string, action: FlagChangeAction, summary: string, time = ctx.now()) => {
      const list = history.get(key) ?? [];
      list.unshift({ id: `c${++seq}`, time, author: ADMIN, action, summary });
      history.set(key, list);
    };
    for (const f of flags.values()) {
      log(f.key, "created", `Created with ${f.variants.length} variants`, f.createdAt);
      if (f.updatedAt > f.createdAt) log(f.key, "updated", "Changed the targeting", f.updatedAt);
      if (f.archived) log(f.key, "archived", "Archived", f.updatedAt);
    }
    const watchers = new Set<() => void>();
    const changed = () =>
      setTimeout(() => {
        for (const w of watchers) w();
      }, 0);
    const writable = () => {
      if (!ctx.can("write")) throw new DataSourceError("unauthorized", "this credential cannot change feature flags");
    };
    const get = (key: string) => {
      const f = flags.get(key);
      if (!f) throw new DataSourceError("not_found", `no flag "${key}"`);
      return f;
    };
    const copy = (f: FeatureFlag) => structuredClone(f);

    return {
      listFlags: (opts?: { signal?: AbortSignal }) =>
        ctx.call(opts?.signal, () => [...flags.values()].sort((a, b) => a.key.localeCompare(b.key)).map(copy)),

      watchFlags: (onChange: () => void) => {
        watchers.add(onChange);
        return () => watchers.delete(onChange);
      },

      getFlagHistory: (key: string, opts?: { signal?: AbortSignal }) =>
        ctx.call(opts?.signal, () => {
          get(key);
          return structuredClone(history.get(key) ?? []);
        }),

      flagExposures: (key: string, w: MetricsWindow, opts?: { signal?: AbortSignal }) =>
        ctx.call(opts?.signal, (): FlagExposures => {
          const f = get(key);
          const step = (w.end - w.start) / w.numBuckets;
          const share = shares(f);
          // a stable traffic shape per flag, so the chart does not jump between refreshes
          let h = 0;
          for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          const base = 40 + (h % 80);
          return f.variants.map((v) => ({
            variant: v.key,
            series: Array.from({ length: w.numBuckets }, (_, i) => {
              const time = w.start + i * step;
              if (f.archived || time < f.createdAt) return { time, value: null };
              const wave = 1 + 0.3 * Math.sin((i + (h % 7)) / 6);
              return { time, value: Math.round(base * wave * (share.get(v.key) ?? 0)) };
            }),
          }));
        }),

      saveFlag: (input: FlagInput, opts?: { signal?: AbortSignal }) =>
        ctx.call(opts?.signal, () => {
          writable();
          const existing = flags.get(input.key);
          const problem = flagProblem(input);
          if (problem) throw new DataSourceError("invalid_request", problem);
          const now = ctx.now();
          const f: FeatureFlag = {
            ...structuredClone(input),
            archived: existing?.archived ?? false,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            updatedBy: ADMIN,
          };
          flags.set(f.key, f);
          log(
            f.key,
            existing ? "updated" : "created",
            existing ? "Edited" : `Created with ${f.variants.length} variants`,
          );
          ctx.record(existing ? "update_feature_flag" : "create_feature_flag", { flag: f.key });
          changed();
          return copy(f);
        }),

      setFlagEnabled: (key: string, enabled: boolean, opts?: { signal?: AbortSignal }) =>
        ctx.call(opts?.signal, () => {
          writable();
          const f = get(key);
          if (f.enabled === enabled) return;
          f.enabled = enabled;
          f.updatedAt = ctx.now();
          log(key, enabled ? "enabled" : "disabled", enabled ? "Turned on" : "Turned off for everyone");
          ctx.record(enabled ? "enable_feature_flag" : "disable_feature_flag", { flag: key });
          changed();
        }),

      archiveFlag: (key: string, archived: boolean, opts?: { signal?: AbortSignal }) =>
        ctx.call(opts?.signal, () => {
          writable();
          const f = get(key);
          if (f.archived === archived) return;
          f.archived = archived;
          if (archived) f.enabled = false;
          f.updatedAt = ctx.now();
          log(key, archived ? "archived" : "restored", archived ? "Archived (and turned off)" : "Restored");
          ctx.record(archived ? "archive_feature_flag" : "restore_feature_flag", { flag: key });
          changed();
        }),
    };
  },
};

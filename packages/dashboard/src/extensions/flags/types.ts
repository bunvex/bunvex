// The contract's feature-flags area (UI-01 §28, an extension of §26; a bunvex addition, STUDY-12 §16): flags
// with variants, targeting rules on the caller's identity, a percentage rollout and a kill switch; their
// change history and how often each variant was served. Every method optional (typeof-detected).
import type { CallOptions, DataSourceError, Json, MetricsWindow, Timeseries, Unsubscribe } from "../../data-source.ts";

/** boolean: two variants, on/off. variant: named string variants. json: variants carry a JSON value. */
export type FlagType = "boolean" | "variant" | "json";

export type FlagVariant = {
  /** Unique in the flag, e.g. "on", "control", "blue". */
  key: string;
  /** What the flag evaluates to for this variant. */
  value: Json;
  description?: string;
};

/** Compares an identity attribute ("email", "tokenIdentifier", "org", a custom claim) with values. */
export type FlagOperator = "equals" | "notEquals" | "in" | "notIn" | "contains" | "startsWith" | "endsWith" | "exists";
export const FLAG_OPERATORS: readonly FlagOperator[] = [
  "equals",
  "notEquals",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "endsWith",
  "exists",
];

export type FlagCondition = { attribute: string; operator: FlagOperator; values: string[] };

/** Variants with weights (summing to 100): who gets which is fixed per identity (a stable hash). */
export type FlagRollout = { variant: string; weight: number }[];

/** A rule serves one variant, or a rollout, to the identities that meet all its conditions. */
export type FlagRule = {
  id: string;
  description?: string;
  conditions: FlagCondition[];
  serve: { variant: string } | { rollout: FlagRollout };
};

export type FeatureFlag = {
  key: string;
  name: string;
  description?: string;
  type: FlagType;
  /** The kill switch: off serves `offVariant` to everyone. */
  enabled: boolean;
  variants: FlagVariant[];
  /** Served when on and no rule matches: a variant, or a rollout. */
  fallthrough: { variant: string } | { rollout: FlagRollout };
  /** Served to everyone when off. */
  offVariant: string;
  /** In order: the first rule that matches serves. */
  rules: FlagRule[];
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
};

/** What a create or an edit sends; the source sets the timestamps and the author. */
export type FlagInput = Omit<FeatureFlag, "createdAt" | "updatedAt" | "updatedBy" | "archived">;

export type FlagChangeAction = "created" | "updated" | "enabled" | "disabled" | "archived" | "restored";

export type FlagChange = {
  id: string;
  time: number;
  author: string | null;
  action: FlagChangeAction;
  /** In words, e.g. "rollout of on: 10 % → 25 %". */
  summary: string;
};

/** How many evaluations served each variant, per bucket. */
export type FlagExposures = { variant: string; series: Timeseries }[];

export interface FlagsFeatures {
  /** Every flag, archived ones included, by key. */
  listFlags?(opts?: CallOptions): Promise<FeatureFlag[]>;
  /** Tells when any flag changes; the screen refetches. */
  watchFlags?(onChange: () => void, onError: (error: DataSourceError) => void): Unsubscribe;
  getFlagHistory?(key: string, opts?: CallOptions): Promise<FlagChange[]>;
  flagExposures?(key: string, window: MetricsWindow, opts?: CallOptions): Promise<FlagExposures>;
  /** Creates (a new key) or replaces a flag. Rejects `invalid_request` with the reason when it is not valid. */
  saveFlag?(flag: FlagInput, opts?: CallOptions): Promise<FeatureFlag>;
  /** The kill switch. */
  setFlagEnabled?(key: string, enabled: boolean, opts?: CallOptions): Promise<void>;
  archiveFlag?(key: string, archived: boolean, opts?: CallOptions): Promise<void>;
}

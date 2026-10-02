// The flags screen's URL state (UI-01 §28): which flags (a view and a type), a search, the open flag and its
// tab, and the editor (a new flag, or the open one).
export type FlagsView = "active" | "enabled" | "disabled" | "archived";
export type FlagsTab = "overview" | "targeting" | "history" | "code";
export type FlagsSearch = {
  view?: FlagsView;
  type?: "boolean" | "variant" | "json";
  q?: string;
  flag?: string;
  tab?: FlagsTab;
  /** "new": the create form; "edit": the open flag's. */
  editor?: "new" | "edit";
};

const one = <T extends string>(v: unknown, options: readonly T[]) =>
  typeof v === "string" && (options as readonly string[]).includes(v) ? (v as T) : undefined;

export const validateFlagsSearch = (input: Record<string, unknown>): FlagsSearch => ({
  // every key, `undefined` when invalid: the router keeps a raw param the validator leaves out
  view: one(input.view, ["active", "enabled", "disabled", "archived"] as const),
  type: one(input.type, ["boolean", "variant", "json"] as const),
  q: typeof input.q === "string" && input.q ? input.q : undefined,
  flag: typeof input.flag === "string" && input.flag ? input.flag : undefined,
  tab: one(input.tab, ["overview", "targeting", "history", "code"] as const),
  editor: one(input.editor, ["new", "edit"] as const),
});

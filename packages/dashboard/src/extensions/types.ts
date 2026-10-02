// What an extension declares (UI-01 §26). An extension is a screen (or a few) that lives in its own folder,
// with its own part of the contract, of the mock and of the contract suite, and is listed in the registries
// next to this file — so a screen can be tried and removed again: delete the folder and its lines in
// `index.ts`, `mock.ts` and `contract.ts` (the compiler points at any line left behind).
import type { ComponentType } from "react";
import type { DashboardDataSource } from "../data-source.ts";

export type ExtensionIcon = ComponentType<{ className?: string; "aria-hidden"?: "true" }>;

/** The sidebar group an extension's entry joins (UI-01 §23.2); "extensions" is its own group before Settings. */
export type NavGroupId = "overview" | "data" | "functions" | "manage" | "observe" | "extensions";

export type ExtensionRoute = {
  /** Relative to the dashboard's root, without a leading slash: "flags", "flags/$flag". */
  path: string;
  /** The screen's module, fetched when the route is first matched (each screen its own chunk, UI-01 §14.1). */
  load: () => Promise<Record<string, unknown>>;
  /** The component's export name in that module. */
  component: string;
  /** Validates the route's search params; drop invalid values (return every key, `undefined` when invalid). */
  validateSearch?: (input: Record<string, unknown>) => Record<string, unknown>;
};

export type ExtensionNavItem = { label: string; to: string };

export type DashboardExtension = {
  /** Unique, kebab-case: the folder's name. */
  id: string;
  title: string;
  icon: ExtensionIcon;
  /** Where its sidebar entry goes: the group, its place after the built-in entries (lower first), the link. */
  nav: { group: NavGroupId; order: number; to: string };
  routes: readonly ExtensionRoute[];
  /**
   * The contract methods the screens need. The sidebar entry shows only when the source has every one
   * (`typeof source[m] === "function"`); a route reached anyway says the deployment does not offer it.
   */
  requires: readonly (keyof DashboardDataSource)[];
  /** The section column's navigation (UI-01 §23), when the extension has sub-screens. */
  column?: readonly { label?: string; items: readonly ExtensionNavItem[] }[];
};

/** Whether a source offers everything an extension needs. */
export function offers(source: DashboardDataSource, ext: Pick<DashboardExtension, "requires">): boolean {
  return ext.requires.every((m) => typeof source[m] === "function");
}

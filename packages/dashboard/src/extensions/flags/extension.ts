// The feature flags extension's declaration (UI-01 §28): one screen at /flags, under Manage, shown when the
// source has `listFlags`. The screen is a lazy chunk; this module stays light.
import { Flag } from "lucide-react";
import type { DashboardExtension } from "../types.ts";
import { validateFlagsSearch } from "./search.ts";

export const flagsExtension: DashboardExtension = {
  id: "flags",
  title: "Feature flags",
  icon: Flag,
  nav: { group: "manage", order: 10, to: "/flags" },
  routes: [
    {
      path: "flags",
      load: () => import("./screen.tsx"),
      component: "FlagsScreen",
      validateSearch: validateFlagsSearch,
    },
  ],
  requires: ["listFlags"],
};

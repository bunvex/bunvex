// The extensions the dashboard shows (UI-01 §26): the registry's, or the host's (`<Dashboard extensions>`).
import { createContext, useContext } from "react";
import { extensions } from "./index.ts";
import type { DashboardExtension } from "./types.ts";

export const ExtensionsContext = createContext<readonly DashboardExtension[]>(extensions);
export const useExtensions = () => useContext(ExtensionsContext);

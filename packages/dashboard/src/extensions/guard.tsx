// A route of an extension (UI-01 §26), reached even when the source lacks what it needs (a typed URL, a link):
// it says the deployment does not offer it, as the built-in screens do (§14).
import type { ComponentType, ReactNode } from "react";
import { useQueryScope } from "../context.tsx";
import { NotOffered } from "../shell/not-offered.tsx";
import { type DashboardExtension, offers } from "./types.ts";

export function guarded(ext: DashboardExtension, Screen: ComponentType): () => ReactNode {
  function ExtensionRoute(): ReactNode {
    const { source } = useQueryScope();
    if (!offers(source, ext)) return <NotOffered title={ext.title} what={ext.title.toLowerCase()} />;
    return <Screen />;
  }
  ExtensionRoute.displayName = `Extension(${ext.id})`;
  return ExtensionRoute;
}

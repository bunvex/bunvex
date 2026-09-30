// The Settings screens' frame (UI-01 §14.4, §17.1): the heading and the pages beside them, as Convex's
// settings sidebar (`DeploymentSettingsLayout.tsx`, `deploymentSettingsPages.ts`) — General first.
import type { ReactNode } from "react";
import { DashLink } from "../router.tsx";

const TAB =
  "block border-l-2 border-transparent px-2 py-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground";

export function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <div className="flex flex-col gap-6 lg:flex-row">
        <nav aria-label="Settings" className="lg:w-52 lg:shrink-0">
          <ul>
            <li>
              <DashLink link={{ to: "/settings/general" }} className={TAB}>
                General
              </DashLink>
            </li>
            <li>
              <DashLink link={{ to: "/settings/environment-variables" }} className={TAB}>
                Environment variables
              </DashLink>
            </li>
          </ul>
        </nav>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

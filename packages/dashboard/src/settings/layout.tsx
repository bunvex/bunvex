// The Settings screens' frame (UI-01 §14.4, §17.1, §23): the section column with the pages in groups, as
// Convex's settings sidebar (`DeploymentSettingsLayout.tsx`, `deploymentSettingsPages.ts`) — General first —
// and the page beside it: Bar 1 (its name and what it is for), then its content, scrolling inside.
import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryScope } from "../context.tsx";
import { useExtensions } from "../extensions/context.ts";
import { ExtensionLink } from "../extensions/link.tsx";
import { offers } from "../extensions/types.ts";
import { DashLink } from "../router.tsx";
import { BAR_TITLE, BAR1, SCREEN } from "../shell/bars.ts";
import { SECTION_ITEM, SectionColumn, SectionNav, useSectionSheet } from "../shell/section-column.tsx";

function SettingsNav() {
  const { source } = useQueryScope();
  // pages the shown extensions add (UI-01 §26), only for those the deployment offers
  const fromExtensions = useExtensions()
    .filter((e) => offers(source, e))
    .flatMap((e) => e.settings ?? []);
  return (
    <SectionNav
      label="Settings"
      groups={[
        {
          label: "Configuration",
          items: (
            <>
              <li>
                <DashLink link={{ to: "/settings/general" }} className={SECTION_ITEM}>
                  General
                </DashLink>
              </li>
              <li>
                <DashLink link={{ to: "/settings/environment-variables" }} className={SECTION_ITEM}>
                  Environment variables
                </DashLink>
              </li>
            </>
          ),
        },
        {
          label: "Data",
          items: (
            <li>
              <DashLink link={{ to: "/settings/snapshots" }} className={SECTION_ITEM}>
                Snapshots
              </DashLink>
            </li>
          ),
        },
        ...(fromExtensions.length > 0
          ? [
              {
                label: "Extensions",
                items: fromExtensions.map((item) => (
                  <li key={item.to}>
                    <ExtensionLink to={item.to} className={SECTION_ITEM}>
                      {item.label}
                    </ExtensionLink>
                  </li>
                )),
              },
            ]
          : []),
      ]}
    />
  );
}

// A page's own actions go in Bar 1, beside its title (UX2-9): the page renders them through BarActions.
const BarSlot = createContext<HTMLElement | null>(null);

/** Actions for the settings page's Bar 1 (e.g. "Add a variable"), rendered there from inside the page. */
export function BarActions({ children }: { children: ReactNode }) {
  const slot = useContext(BarSlot);
  return slot ? createPortal(children, slot) : null;
}

export function SettingsLayout(props: { title: string; description?: string; children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const sheet = useSectionSheet({ kind: "settings-pages", label: "Settings", children: <SettingsNav /> });
  return (
    <div className={SCREEN}>
      <SectionColumn title="Settings" widthKey="bunvex-dashboard:settings-column-width">
        <SettingsNav />
      </SectionColumn>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={BAR1}>
          <h1 className={BAR_TITLE}>{props.title}</h1>
          {props.description && (
            <span className="hidden text-sm text-muted-foreground sm:inline">{props.description}</span>
          )}
          <span ref={setSlot} className="ml-auto flex items-center gap-2" />
          {sheet.button}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <BarSlot.Provider value={slot}>{props.children}</BarSlot.Provider>
        </div>
      </div>
      {sheet.sheet}
    </div>
  );
}

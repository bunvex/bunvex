// The Schedules screen's section column (UI-01 §23): its two pages — scheduled functions and cron jobs —
// and, under them on Scheduled functions, that page's filters.
import type { ReactNode } from "react";
import { DashLink } from "../router.tsx";
import { SECTION_ITEM, SectionColumn, SectionNav, useSectionSheet } from "../shell/section-column.tsx";

export function SchedulesNav(props: { withFilters?: boolean }) {
  return (
    <SectionNav
      label="Schedules"
      withFilters={props.withFilters}
      groups={[
        {
          items: (
            <>
              <li>
                <DashLink link={{ to: "/schedules/functions" }} className={SECTION_ITEM}>
                  Scheduled functions
                </DashLink>
              </li>
              <li>
                <DashLink link={{ to: "/schedules/crons" }} className={SECTION_ITEM}>
                  Cron jobs
                </DashLink>
              </li>
            </>
          ),
        },
      ]}
    />
  );
}

/** The column (from `md`) and, for Bar 1, the button of its sheet (phones). */
export function useSchedulesColumn(filters?: ReactNode, onReset?: () => void) {
  const content = (
    <>
      <SchedulesNav withFilters={!!filters} />
      {filters}
    </>
  );
  const sheet = useSectionSheet({ kind: "schedules-sections", label: "Schedules", onReset, children: content });
  const column = (
    <SectionColumn title="Schedules" widthKey="bunvex-dashboard:schedules-column-width">
      {content}
    </SectionColumn>
  );
  return { column, button: sheet.button, sheet: sheet.sheet };
}

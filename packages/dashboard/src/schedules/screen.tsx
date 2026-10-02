// The Schedules screen (UI-01 §14.2, §23, STUDY-12 §9): Convex's two pages — scheduled functions
// (`/schedules/functions`) and cron jobs (`/schedules/crons`) — in the screen's section column.

import { useQueryScope } from "../context.tsx";
import { BAR_TITLE, BAR1, SCREEN } from "../shell/bars.ts";
import { NotOffered } from "../shell/not-offered.tsx";
import { useSchedulesColumn } from "./column.tsx";
import { CronsView } from "./crons-view.tsx";
import { ScheduledView } from "./scheduled-view.tsx";

/** A page this deployment does not offer: the column, and a sentence. */
function Missing({ title, what }: { title: string; what: string }) {
  const { column, button, sheet } = useSchedulesColumn();
  return (
    <>
      {column}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className={BAR1}>
          <h1 className={BAR_TITLE}>{title}</h1>
          {button}
        </div>
        <p className="p-4 text-sm text-muted-foreground md:p-6">This deployment does not offer {what} yet.</p>
      </div>
      {sheet}
    </>
  );
}

function Schedules({ view }: { view: "functions" | "crons" }) {
  const { source } = useQueryScope();
  if (typeof source.listScheduledFunctions !== "function" && typeof source.listCronJobs !== "function")
    return <NotOffered title="Schedules" what="scheduled functions or cron jobs" />;
  return (
    // full-bleed (UI-01 §22.5): Bar 1 with the two pages, the grid to the bottom, the details docked
    <div className={SCREEN}>
      {view === "functions" ? (
        typeof source.listScheduledFunctions === "function" ? (
          <ScheduledView />
        ) : (
          <Missing title="Scheduled functions" what="scheduled functions" />
        )
      ) : typeof source.listCronJobs === "function" ? (
        <CronsView />
      ) : (
        <Missing title="Cron jobs" what="cron jobs" />
      )}
    </div>
  );
}

export const ScheduledFunctionsScreen = () => <Schedules view="functions" />;
export const CronJobsScreen = () => <Schedules view="crons" />;

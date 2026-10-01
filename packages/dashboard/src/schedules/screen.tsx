// The Schedules screen (UI-01 §14.2, STUDY-12 §9): Convex's two pages under one heading — scheduled
// functions (`/schedules/functions`) and cron jobs (`/schedules/crons`).

import { cn } from "@bunvex/ui/lib/utils";
import { useQueryScope } from "../context.tsx";
import { DashLink } from "../router.tsx";
import { BAR_TITLE, BAR1, SCREEN } from "../shell/bars.ts";
import { NotOffered } from "../shell/not-offered.tsx";
import { CronsView } from "./crons-view.tsx";
import { ScheduledView } from "./scheduled-view.tsx";

// in Bar 1: the current page underlined
const TAB =
  "inline-block border-b-2 border-transparent px-1 py-0.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground";

/** Bar 1's start on both pages: the heading and the two pages as tabs. */
function Heading() {
  return (
    <>
      {/* a narrow bar (beside the filters and a docked panel) keeps the two tabs; the heading stays for assistive tech */}
      <h1 className={cn(BAR_TITLE, "sr-only @2xl/schedules:not-sr-only")}>Schedules</h1>
      <nav aria-label="Schedules" className="mr-2">
        <ul className="flex gap-4">
          <li>
            <DashLink link={{ to: "/schedules/functions" }} className={TAB}>
              Scheduled functions
            </DashLink>
          </li>
          <li>
            <DashLink link={{ to: "/schedules/crons" }} className={TAB}>
              Cron jobs
            </DashLink>
          </li>
        </ul>
      </nav>
    </>
  );
}

function Schedules({ view }: { view: "functions" | "crons" }) {
  const { source } = useQueryScope();
  if (typeof source.listScheduledFunctions !== "function" && typeof source.listCronJobs !== "function")
    return <NotOffered title="Schedules" what="scheduled functions or cron jobs" />;
  const missing = (what: string) => (
    <div className="@container/schedules flex min-w-0 flex-1 flex-col">
      <div className={BAR1}>
        <Heading />
      </div>
      <p className="p-4 text-sm text-muted-foreground md:p-6">This deployment does not offer {what} yet.</p>
    </div>
  );
  return (
    // full-bleed (UI-01 §22.5): Bar 1 with the two pages, the grid to the bottom, the details docked
    <div className={SCREEN}>
      {view === "functions" ? (
        typeof source.listScheduledFunctions === "function" ? (
          <ScheduledView heading={<Heading />} />
        ) : (
          missing("scheduled functions")
        )
      ) : typeof source.listCronJobs === "function" ? (
        <CronsView heading={<Heading />} />
      ) : (
        missing("cron jobs")
      )}
    </div>
  );
}

export const ScheduledFunctionsScreen = () => <Schedules view="functions" />;
export const CronJobsScreen = () => <Schedules view="crons" />;

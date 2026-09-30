// The Schedules screen (UI-01 §14.2, STUDY-12 §8): Convex's two pages under one heading — scheduled
// functions (`/schedules/functions`) and cron jobs (`/schedules/crons`).
import { useQueryScope } from "../context.tsx";
import { DashLink } from "../router.tsx";
import { CronsView } from "./crons-view.tsx";
import { ScheduledView } from "./scheduled-view.tsx";

const TAB =
  "border-b-2 border-transparent px-1 pb-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground";

/** A screen for a feature the source does not have (an optional contract method). */
export function NotOffered({ title, what }: { title: string; what: string }) {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">This deployment does not offer {what} yet.</p>
    </>
  );
}

function Schedules({ view }: { view: "functions" | "crons" }) {
  const { source } = useQueryScope();
  if (typeof source.listScheduledFunctions !== "function" && typeof source.listCronJobs !== "function")
    return <NotOffered title="Schedules" what="scheduled functions or cron jobs" />;
  return (
    // full-bleed inside <main>: the details panel runs to its edges
    <div className="-m-4 flex min-h-[calc(100svh-3rem)] md:-m-6">
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-6">
        <h1 className="text-xl font-semibold tracking-tight">Schedules</h1>
        <nav aria-label="Schedules">
          <ul className="flex gap-4 border-b">
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
        {view === "functions" ? (
          typeof source.listScheduledFunctions === "function" ? (
            <ScheduledView />
          ) : (
            <p className="text-sm text-muted-foreground">This deployment does not offer scheduled functions yet.</p>
          )
        ) : typeof source.listCronJobs === "function" ? (
          <CronsView />
        ) : (
          <p className="text-sm text-muted-foreground">This deployment does not offer cron jobs yet.</p>
        )}
      </div>
    </div>
  );
}

export const ScheduledFunctionsScreen = () => <Schedules view="functions" />;
export const CronJobsScreen = () => <Schedules view="crons" />;

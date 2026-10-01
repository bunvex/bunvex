// The frame around every screen: navigation, the deployment the dashboard is looking at, and the main
// region. After each navigation, focus moves to the main region so a screen reader announces the screen.

import { Button } from "@bunvex/ui/components/button";
import { cn } from "@bunvex/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  CalendarClock,
  Database,
  FileBox,
  FunctionSquare,
  History,
  Menu,
  Network,
  Play,
  ScrollText,
  Settings,
  Waypoints,
} from "lucide-react";
import { createContext, lazy, type ReactNode, Suspense, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, deploymentQuery } from "../data/queries.ts";
import { DashLink } from "../router.tsx";
import { type Runner, RunnerContext } from "../runner/context.tsx";
import { PausedBanner } from "./paused-banner.tsx";

// the runner is fetched when it first opens (it brings the code editor and the result views)
const FunctionRunner = lazy(() => import("../runner/runner.tsx").then((m) => ({ default: m.FunctionRunner })));

/** What the host renders at the end of the header (`<Dashboard headerActions>`). */
export const HeaderActionsContext = createContext<ReactNode>(null);

// the active state is styled from the aria-current="page" the router's Link sets: Link concatenates
// activeProps classes without tailwind-merge, so they could not override border-transparent
const NAV_LINK =
  "flex h-8 items-center gap-2 border-b-2 border-transparent px-2 text-sm whitespace-nowrap outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring md:border-b-0 md:border-l-2 aria-[current=page]:border-sidebar-primary aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground";
const ICON = "hidden size-4 shrink-0 sm:block";

export function Shell() {
  const headerActions = useContext(HeaderActionsContext);
  const main = useRef<HTMLElement>(null);
  const router = useRouter();
  const runner = useRunnerState();
  // below md the screens' list is a menu (UI-01 §17.4): a disclosure that closes on a pick or on Escape
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(
    () =>
      router.subscribe("onResolved", (e) => {
        // not on the first load, and not when only the search changed (a filter, a sort)
        if (e.fromLocation && e.fromLocation.pathname !== e.toLocation.pathname) main.current?.focus();
      }),
    [router],
  );

  return (
    <RunnerContext.Provider value={runner.context}>
      <div className="flex min-h-svh flex-col bg-background text-foreground md:flex-row">
        {/* a button, not a link to #main: the host may route on the hash */}
        <button
          type="button"
          onClick={() => main.current?.focus()}
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-ring"
        >
          Skip to content
        </button>
        <nav
          aria-label="Dashboard"
          className="shrink-0 border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:w-52 md:border-r md:border-b-0"
        >
          <div className="flex h-12 items-center justify-between px-4 font-semibold tracking-tight">
            bunvex
            <Button
              ref={menuButton}
              variant="ghost"
              size="sm"
              className="md:hidden"
              aria-expanded={menuOpen}
              aria-controls="dashboard-screens"
              onClick={() => setMenuOpen((o) => !o)}
            >
              <Menu aria-hidden="true" />
              Menu
            </Button>
          </div>
          <ul
            id="dashboard-screens"
            className={cn("flex-col gap-1 px-2 pb-2 md:flex", menuOpen ? "flex" : "hidden")}
            onClick={(e) => {
              if ((e.target as Element).closest("a")) setMenuOpen(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && menuOpen) {
                setMenuOpen(false);
                menuButton.current?.focus();
              }
            }}
          >
            <li>
              <DashLink link={{ to: "/", activeOptions: { exact: true } }} className={NAV_LINK}>
                <Activity className={ICON} aria-hidden="true" />
                Health
              </DashLink>
            </li>
            <li>
              <DashLink link={{ to: "/topology" }} className={NAV_LINK}>
                <Waypoints className={ICON} aria-hidden="true" />
                Topology
              </DashLink>
            </li>
            <li>
              <DashLink link={{ to: "/database" }} className={NAV_LINK}>
                <Database className={ICON} aria-hidden="true" />
                Database
              </DashLink>
            </li>
            <li>
              <DashLink link={{ to: "/schema" }} className={NAV_LINK}>
                <Network className={ICON} aria-hidden="true" />
                Schema
              </DashLink>
            </li>
            <li>
              <DashLink link={{ to: "/functions" }} className={NAV_LINK}>
                <FunctionSquare className={ICON} aria-hidden="true" />
                Functions
              </DashLink>
            </li>
            <li>
              <DashLink link={{ to: "/files" }} className={NAV_LINK}>
                <FileBox className={ICON} aria-hidden="true" />
                Files
              </DashLink>
            </li>
            <li>
              <DashLink link={{ to: "/schedules" }} className={NAV_LINK}>
                <CalendarClock className={ICON} aria-hidden="true" />
                Schedules
              </DashLink>
            </li>
            <li>
              <DashLink link={{ to: "/logs" }} className={NAV_LINK}>
                <ScrollText className={ICON} aria-hidden="true" />
                Logs
              </DashLink>
            </li>
            <li>
              <DashLink link={{ to: "/history" }} className={NAV_LINK}>
                <History className={ICON} aria-hidden="true" />
                History
              </DashLink>
            </li>
            <li>
              <DashLink link={{ to: "/settings" }} className={NAV_LINK}>
                <Settings className={ICON} aria-hidden="true" />
                Settings
              </DashLink>
            </li>
          </ul>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex min-h-12 items-center gap-4 border-b px-4 py-2 md:px-6">
            <div className="min-w-0 flex-1">
              <DeploymentSummary />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {runner.context.available && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={runner.context.shown}
                  title="Ctrl+`"
                  onClick={() => (runner.context.shown ? runner.context.close() : runner.context.open())}
                >
                  <Play aria-hidden="true" />
                  {/* an icon on a phone; its name stays for assistive tech (UX-4) */}
                  <span className="sr-only sm:not-sr-only">Run functions</span>
                </Button>
              )}
              {headerActions}
            </div>
          </header>
          <PausedBanner />
          {/* with the runner docked below, the screen keeps room to scroll past it */}
          <main
            id="main"
            ref={main}
            tabIndex={-1}
            className={cn("flex-1 p-4 outline-none md:p-6", runner.context.shown && "pb-[calc(45svh+1.5rem)]")}
          >
            <Outlet />
          </main>
        </div>
        {runner.context.shown && (
          <Suspense fallback={null}>
            <FunctionRunner
              key={runner.path ?? ""}
              path={runner.path}
              onPath={runner.context.open}
              onClose={runner.context.close}
            />
          </Suspense>
        )}
      </div>
    </RunnerContext.Provider>
  );
}

/** The runner's state: shown or not, on which function; Ctrl+` toggles it, as in Convex. */
function useRunnerState(): { context: Runner; path?: string } {
  const scope = useQueryScope();
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const available = typeof scope.source.runFunction === "function" && !!caps?.operations.includes("runFunctions");
  const [shown, setShown] = useState(false);
  const [path, setPath] = useState<string>();
  // the function open on the Functions screen: the header's Run and Ctrl+` open the runner on it, as
  // Convex's runner follows the selected function (UX-3); elsewhere the runner keeps the last one
  const viewing = useRouterState({
    select: (s) => {
      const search = s.matches.find((m) => m.routeId === "/functions")?.search as { function?: string } | undefined;
      return search?.function;
    },
  });
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  const context = useMemo<Runner>(
    () => ({
      available,
      shown: available && shown,
      open: (p) => {
        const target = p ?? viewingRef.current;
        if (target) setPath(target);
        setShown(true);
      },
      close: () => setShown(false),
    }),
    [available, shown],
  );
  useEffect(() => {
    if (!available) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "`" && e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setShown((s) => {
          if (!s && viewingRef.current) setPath(viewingRef.current);
          return !s;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [available]);
  return { context, path };
}

function DeploymentSummary() {
  const { data, error } = useQuery(deploymentQuery(useQueryScope()));
  if (error) return <p className="text-sm text-destructive">Deployment unavailable</p>;
  const items: [string, string | undefined][] = [
    ["Deployment", data?.name],
    ["Persistence", data?.persistence],
    ["Version", data?.version],
  ];
  return (
    <>
      {/* on a phone, one muted line instead of three labelled ones (UX-4) */}
      <p className="truncate text-xs text-muted-foreground md:hidden" aria-busy={!data}>
        {items.map(([label, value]) => (
          <span key={label}>
            <span className="sr-only">{label} </span>
            {value ?? "…"}
            {label !== "Version" && <span aria-hidden="true"> · </span>}
          </span>
        ))}
      </p>
      <dl className="hidden flex-wrap items-baseline gap-x-5 gap-y-1 text-sm md:flex" aria-busy={!data}>
        {items.map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-1.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={cn("font-medium", label === "Version" && "font-mono text-xs")}>{value ?? "…"}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

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
  KeyRound,
  Menu,
  Network,
  Play,
  ScrollText,
  Settings,
  Waypoints,
} from "lucide-react";
import {
  type ComponentProps,
  type ComponentType,
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, deploymentQuery } from "../data/queries.ts";
import { useExtensions } from "../extensions/context.ts";
import { ExtensionLink } from "../extensions/link.tsx";
import { type NavGroupId, offers } from "../extensions/types.ts";
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

/** A group of screens in the sidebar, under a small label (none for the first and the last). */
function NavGroup({ label, children }: { label?: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      {label ? (
        <p
          id={id}
          className="px-2 pt-3 pb-0.5 text-[11px] font-medium tracking-wide text-sidebar-foreground/60 uppercase"
        >
          {label}
        </p>
      ) : (
        <div className="pt-2" />
      )}
      <ul aria-labelledby={label ? id : undefined} className="flex flex-col gap-1">
        {children}
      </ul>
    </div>
  );
}

function NavItem(props: {
  link: ComponentProps<typeof DashLink>["link"];
  icon: ComponentType<{ className?: string; "aria-hidden"?: "true" }>;
  children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <li>
      <DashLink link={props.link} className={NAV_LINK}>
        <Icon className={ICON} aria-hidden="true" />
        {props.children}
      </DashLink>
    </li>
  );
}

/** The extensions' entries of one sidebar group (UI-01 §26): only those the source offers, in their order. */
function ExtensionNavItems({ group }: { group: NavGroupId }) {
  const { source } = useQueryScope();
  const items = useExtensions()
    .filter((e) => e.nav.group === group && offers(source, e))
    .sort((a, b) => a.nav.order - b.nav.order);
  return items.map((e) => {
    const Icon = e.icon;
    return (
      <li key={e.id}>
        <ExtensionLink to={e.nav.to} className={NAV_LINK}>
          <Icon className={ICON} aria-hidden="true" />
          {e.title}
        </ExtensionLink>
      </li>
    );
  });
}

/** The "Extensions" group, when some extension joins it and the source offers it. */
function ExtensionsGroup() {
  const { source } = useQueryScope();
  if (!useExtensions().some((e) => e.nav.group === "extensions" && offers(source, e))) return null;
  return (
    <NavGroup label="Extensions">
      <ExtensionNavItems group="extensions" />
    </NavGroup>
  );
}

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
          {/* biome-ignore lint/a11y/noStaticElementInteractions: it only listens for a pick (a link's click) and Escape */}
          <div
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
            {/* the screens in labelled groups (UI-01 §23.2); Settings last, on its own */}
            <NavGroup>
              <NavItem link={{ to: "/", activeOptions: { exact: true } }} icon={Activity}>
                Health
              </NavItem>
              <NavItem link={{ to: "/topology" }} icon={Waypoints}>
                Topology
              </NavItem>
              <ExtensionNavItems group="overview" />
            </NavGroup>
            <NavGroup label="Data">
              <NavItem link={{ to: "/database" }} icon={Database}>
                Database
              </NavItem>
              <NavItem link={{ to: "/schema" }} icon={Network}>
                Schema
              </NavItem>
              <NavItem link={{ to: "/files" }} icon={FileBox}>
                Files
              </NavItem>
              <ExtensionNavItems group="data" />
            </NavGroup>
            <NavGroup label="Functions">
              <NavItem link={{ to: "/functions" }} icon={FunctionSquare}>
                Functions
              </NavItem>
              <NavItem link={{ to: "/schedules" }} icon={CalendarClock}>
                Schedules
              </NavItem>
              <ExtensionNavItems group="functions" />
            </NavGroup>
            <NavGroup label="Manage">
              <NavItem link={{ to: "/auth" }} icon={KeyRound}>
                Authentication
              </NavItem>
              <ExtensionNavItems group="manage" />
            </NavGroup>
            <NavGroup label="Observe">
              <NavItem link={{ to: "/logs" }} icon={ScrollText}>
                Logs
              </NavItem>
              <NavItem link={{ to: "/history" }} icon={History}>
                History
              </NavItem>
              <ExtensionNavItems group="observe" />
            </NavGroup>
            <ExtensionsGroup />
            <NavGroup>
              <NavItem link={{ to: "/settings" }} icon={Settings}>
                Settings
              </NavItem>
            </NavGroup>
          </div>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* exactly 48 px with its border (7 + 32 + 7 + 1): the full-height screens take 100svh − 3rem */}
          <header className="flex min-h-12 items-center gap-4 border-b px-4 py-[7px] md:px-6">
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

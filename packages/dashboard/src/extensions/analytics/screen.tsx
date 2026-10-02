// The Analytics extension's screen (UI-01 §26, STUDY-12 §16 — a bunvex addition; Convex has no analytics): on
// the section column, Realtime (the live map and the last 30 minutes), then Events, Sessions and Profiles, and —
// on Events — the event names to narrow to. Offered when the source has `getAnalyticsRealtime`.
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQueryScope } from "../../context.tsx";
import { BAR_TITLE, SCREEN } from "../../shell/bars.ts";
import {
  FacetRadios,
  SECTION_ITEM,
  SectionColumn,
  SectionFilters,
  SectionNav,
  useSectionSheet,
} from "../../shell/section-column.tsx";
import { ExtensionLink } from "../link.tsx";
import type { AnalyticsEvent } from "./data-source.ts";
import { ANALYTICS_SECTIONS, type AnalyticsSection } from "./index.ts";
import { ListPage } from "./lists.tsx";
import { analyticsListQuery } from "./queries.ts";
import { RealtimePage } from "./realtime.tsx";

const SECTION: Record<AnalyticsSection, { title: string; description: string }> = {
  realtime: { title: "Realtime", description: "Who is here now, and the last 30 minutes" },
  events: { title: "Events", description: "Page views and what your app tracks" },
  sessions: { title: "Sessions", description: "Visits, newest first" },
  profiles: { title: "Profiles", description: "The people behind the sessions" },
};

function Nav() {
  const item = (section: AnalyticsSection) => (
    <li key={section}>
      <ExtensionLink to={`/analytics/${section}`} className={SECTION_ITEM}>
        {SECTION[section].title}
      </ExtensionLink>
    </li>
  );
  return (
    <SectionNav
      label="Analytics"
      groups={[{ items: item("realtime") }, { label: "Explore", items: ANALYTICS_SECTIONS.slice(1).map(item) }]}
    />
  );
}

/** Events: narrow to one event name, from the names among the loaded events. */
function EventNames({ name, onName }: { name: string | undefined; onName: (n: string | undefined) => void }) {
  const scope = useQueryScope();
  const all = useInfiniteQuery(analyticsListQuery(scope, "events", ""));
  const counts = new Map<string, number>();
  for (const e of (all.data?.pages.flatMap((p) => p.page) ?? []) as AnalyticsEvent[])
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const names = [...counts.keys()].sort();
  return (
    <SectionFilters label="Event filters" onReset={name ? () => onName(undefined) : undefined}>
      <FacetRadios
        title="Event"
        value={name ?? "all"}
        options={[
          { value: "all", label: "Any event" },
          ...names.map((n) => ({ value: n, label: n, count: counts.get(n), mono: true })),
        ]}
        onChange={(v) => onName(v === "all" ? undefined : v)}
      />
    </SectionFilters>
  );
}

/** The screen (the registry's guard has already checked the source offers Analytics). */
export function AnalyticsScreen() {
  return <Analytics />;
}

function Analytics() {
  // extension routes are outside the router's types (UI-01 §26): read them loosely
  const { section = "realtime" } = useParams({ strict: false }) as { section?: string };
  const search = useSearch({ strict: false }) as { name?: string };
  const navigate = useNavigate();
  const s = ((ANALYTICS_SECTIONS as readonly string[]).includes(section) ? section : "realtime") as AnalyticsSection;
  const filters =
    s === "events" ? (
      <EventNames
        name={search.name}
        onName={(name) => void navigate({ to: ".", search: { name } as never, replace: true })}
      />
    ) : null;
  const sheet = useSectionSheet({
    kind: "analytics-pages",
    label: "Pages",
    children: (
      <>
        <Nav />
        {filters}
      </>
    ),
  });
  const heading = (
    <>
      <h1 className={BAR_TITLE}>{SECTION[s].title}</h1>
      <span className="hidden text-sm text-muted-foreground lg:inline">{SECTION[s].description}</span>
      {sheet.button}
    </>
  );
  return (
    <div className={SCREEN}>
      <SectionColumn title="Analytics" widthKey="bunvex-dashboard:analytics-column-width">
        <Nav />
        {filters}
      </SectionColumn>
      {s === "realtime" ? (
        <RealtimePage heading={heading} />
      ) : (
        <ListPage key={s} list={s} heading={heading} name={s === "events" ? search.name : undefined} />
      )}
      {sheet.sheet}
    </div>
  );
}

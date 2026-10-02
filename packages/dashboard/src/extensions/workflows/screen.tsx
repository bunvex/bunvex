// The Workflows extension's screen (UI-01 §26.3, STUDY-12 §17 — a bunvex addition): on the section column, Runs
// and Work pools; on Runs, the status and workflow filters. A run opens in place (`?run=`), its step selected by
// `?step=`.
import { useQuery } from "@tanstack/react-query";
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
import { RUN_STATUSES, type RunStatus } from "./data-source.ts";
import { WORKFLOW_SECTIONS, type WorkflowSearch, type WorkflowSection } from "./index.ts";
import { namesQuery } from "./queries.ts";
import { RunView } from "./run-view.tsx";
import { RunsPage } from "./runs.tsx";
import { STATUS } from "./words.ts";
import { WorkpoolsPage } from "./workpools.tsx";

const SECTION: Record<WorkflowSection, { title: string; description: string }> = {
  runs: { title: "Runs", description: "Durable workflows, step by step" },
  workpools: { title: "Work pools", description: "Parallelism, queues and retries" },
};

function Nav() {
  return (
    <SectionNav
      label="Workflows"
      groups={[
        {
          items: WORKFLOW_SECTIONS.map((s) => (
            <li key={s}>
              <ExtensionLink to={`/workflows/${s}`} className={SECTION_ITEM}>
                {SECTION[s].title}
              </ExtensionLink>
            </li>
          )),
        },
      ]}
    />
  );
}

function Filters(props: { search: WorkflowSearch; set: (patch: Partial<WorkflowSearch>) => void }) {
  const scope = useQueryScope();
  const names = useQuery(namesQuery(scope)).data ?? [];
  const active = props.search.status !== undefined || props.search.workflow !== undefined;
  return (
    <SectionFilters
      label="Run filters"
      onReset={active ? () => props.set({ status: undefined, workflow: undefined }) : undefined}
    >
      <FacetRadios
        title="Status"
        value={props.search.status ?? "all"}
        options={[
          { value: "all", label: "Any status" },
          ...RUN_STATUSES.map((s) => ({ value: s, label: STATUS[s].word })),
        ]}
        onChange={(v) => props.set({ status: v === "all" ? undefined : (v as RunStatus) })}
      />
      <FacetRadios
        title="Workflow"
        value={props.search.workflow ?? "all"}
        options={[{ value: "all", label: "Any workflow" }, ...names.map((n) => ({ value: n, label: n, mono: true }))]}
        onChange={(v) => props.set({ workflow: v === "all" ? undefined : v })}
      />
    </SectionFilters>
  );
}

/** The screen (the registry's guard has already checked the source offers Workflows). */
export function WorkflowsScreen() {
  // extension routes are outside the router's types (UI-01 §26): read them loosely
  const { section = "runs" } = useParams({ strict: false }) as { section?: string };
  const search = useSearch({ strict: false }) as WorkflowSearch;
  const navigate = useNavigate();
  const s = ((WORKFLOW_SECTIONS as readonly string[]).includes(section) ? section : "runs") as WorkflowSection;
  const set = (patch: Partial<WorkflowSearch>, replace = true) =>
    void navigate({ to: ".", search: ((prev: WorkflowSearch) => ({ ...prev, ...patch })) as never, replace });
  const filters = s === "runs" && !search.run ? <Filters search={search} set={set} /> : null;
  const sheet = useSectionSheet({
    kind: "workflows-pages",
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
      <SectionColumn title="Workflows" widthKey="bunvex-dashboard:workflows-column-width">
        <Nav />
        {filters}
      </SectionColumn>
      {s === "workpools" ? (
        <WorkpoolsPage heading={heading} />
      ) : search.run ? (
        <RunView
          key={search.run}
          id={search.run}
          step={search.step}
          onStep={(step) => set({ step })}
          onBack={() => set({ run: undefined, step: undefined }, false)}
          onOpen={(run) => set({ run, step: undefined }, false)}
        />
      ) : (
        <RunsPage
          heading={heading}
          status={search.status}
          workflow={search.workflow}
          onOpen={(run) => set({ run }, false)}
        />
      )}
      {sheet.sheet}
    </div>
  );
}

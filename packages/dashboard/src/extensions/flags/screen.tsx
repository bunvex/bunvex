// The Feature flags screen (UI-01 §28, an extension of §26; a bunvex addition, STUDY-12 §17). The section
// column holds the views (active, on, off, archived) and the type filter; the grid lists the flags with their
// kill switch; a flag's details dock beside it — what it serves now, how often each variant was served in the
// last hour, its targeting with a "who gets what" preview, its history and the code to read it. New flags and
// edits use the editor in the same panel. Live: a change made elsewhere shows up.
import { Button } from "@bunvex/ui/components/button";
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { Input } from "@bunvex/ui/components/input";
import { LineChart } from "@bunvex/ui/components/line-chart";
import { StatusBadge } from "@bunvex/ui/components/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@bunvex/ui/components/tabs";
import { cn } from "@bunvex/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useQueryScope } from "../../context.tsx";
import { useWatch } from "../../data/live.ts";
import { capabilitiesQuery, dashboardKeys } from "../../data/queries.ts";
import { toDataSourceError } from "../../data-source.ts";
import { formatLiteral } from "../../database/literal.ts";
import { lastHour } from "../../metrics/metrics.ts";
import { formatCount, timeAgo } from "../../screens/stats.ts";
import { BAR_TITLE, BAR1, BAR2, SCREEN } from "../../shell/bars.ts";
import { ConfirmButton } from "../../shell/confirm.tsx";
import { ErrorState } from "../../shell/error-state.tsx";
import { Panel } from "../../shell/panel.tsx";
import {
  FacetRadios,
  SECTION_ITEM,
  SectionColumn,
  SectionFilters,
  SectionNav,
  useSectionSheet,
} from "../../shell/section-column.tsx";
import { formatTime } from "../../shell/time.tsx";
import { useExtensionSearch } from "../search-state.ts";
import { FlagEditor } from "./editor.tsx";
import { evaluate, type FlagIdentity, ruleText, serveText } from "./logic.ts";
import type { FlagsSearch, FlagsView } from "./search.ts";
import type { FeatureFlag, FlagRollout } from "./types.ts";

const col = dataTableColumns<FeatureFlag>();
export const flagsKey = (scope: string) => [...dashboardKeys.all(scope), "flags"] as const;

const VIEWS: readonly { value: FlagsView; label: string; test: (f: FeatureFlag) => boolean }[] = [
  { value: "active", label: "All flags", test: (f) => !f.archived },
  { value: "enabled", label: "On", test: (f) => !f.archived && f.enabled },
  { value: "disabled", label: "Off", test: (f) => !f.archived && !f.enabled },
  { value: "archived", label: "Archived", test: (f) => f.archived },
];
const TYPE_LABEL = { boolean: "Boolean", variant: "Variants", json: "JSON" } as const;

/** Whether this credential may change flags (the mock's rule: a credential that can write data). */
function useCanEdit() {
  const scope = useQueryScope();
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  return (
    !!caps && !caps.readOnly && caps.operations.includes("writeData") && typeof scope.source.saveFlag === "function"
  );
}

export function FlagsScreen() {
  const scope = useQueryScope();
  const { source } = scope;
  const queryClient = useQueryClient();
  const [search, setSearch] = useExtensionSearch<FlagsSearch>("/flags");
  const canEdit = useCanEdit();
  const key = flagsKey(scope.scope);
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => source.listFlags!({ signal }) });
  const liveError = useWatch<void>(
    (onChange, onError) => source.watchFlags?.(onChange, onError) ?? (() => {}),
    () => void queryClient.invalidateQueries({ queryKey: key }),
    [source, scope.scope],
  );
  const flags = list.data ?? [];
  const view = search.view ?? "active";
  const q = (search.q ?? "").toLowerCase();
  const shown = flags.filter(
    (f) =>
      VIEWS.find((v) => v.value === view)!.test(f) &&
      (!search.type || f.type === search.type) &&
      (!q || f.key.includes(q) || f.name.toLowerCase().includes(q)),
  );
  const open = search.flag === undefined ? undefined : (flags.find((f) => f.key === search.flag) ?? null);
  const reset = search.type ? () => setSearch({ type: undefined }) : undefined;

  const nav = (
    <SectionNav
      label="Flag views"
      withFilters
      groups={[
        {
          items: VIEWS.map((v) => (
            <li key={v.value}>
              <button
                type="button"
                className={cn(SECTION_ITEM, "w-full justify-between")}
                aria-current={view === v.value ? "page" : undefined}
                onClick={() => setSearch({ view: v.value === "active" ? undefined : v.value, flag: undefined })}
              >
                {v.label}
                <span className="text-xs text-muted-foreground tabular-nums">{flags.filter(v.test).length}</span>
              </button>
            </li>
          )),
        },
      ]}
    />
  );
  const filters = (
    <SectionFilters label="Flag filters" onReset={reset}>
      <FacetRadios<"any" | FeatureFlag["type"]>
        title="Type"
        options={[
          { value: "any", label: "Any type" },
          ...(["boolean", "variant", "json"] as const).map((t) => ({
            value: t,
            label: TYPE_LABEL[t],
            count: flags.filter((f) => VIEWS.find((v) => v.value === view)!.test(f) && f.type === t).length,
          })),
        ]}
        value={search.type ?? "any"}
        onChange={(t) => setSearch({ type: t === "any" ? undefined : t })}
      />
    </SectionFilters>
  );
  const sheet = useSectionSheet({
    kind: "flags-column",
    label: "Feature flags",
    onReset: reset,
    children: (
      <>
        {nav}
        {filters}
      </>
    ),
  });
  const newButton = canEdit && (
    <Button size="sm" variant="outline" onClick={() => setSearch({ editor: "new", flag: undefined })}>
      <Plus aria-hidden="true" />
      New flag
    </Button>
  );

  const columns: DataTableColumn<FeatureFlag>[] = [
    col.accessor((f) => f.key, {
      id: "key",
      header: "Key",
      cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span>,
    }),
    col.accessor((f) => f.name, { id: "name", header: "Name" }),
    col.accessor((f) => f.type, {
      id: "type",
      header: "Type",
      cell: (c) => (
        <span className="text-xs text-muted-foreground">{TYPE_LABEL[c.getValue() as FeatureFlag["type"]]}</span>
      ),
    }),
    col.accessor((f) => f.enabled, {
      id: "state",
      header: "State",
      cell: (c) => <StateBadge flag={c.row.original} />,
    }),
    col.accessor((f) => (f.enabled ? serveText(f.fallthrough) : `${f.offVariant} (off)`), {
      id: "serving",
      header: "Serving",
      cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span>,
    }),
    col.accessor((f) => f.rules.length, {
      id: "rules",
      header: "Rules",
      cell: (c) => <span className="tabular-nums">{c.getValue()}</span>,
    }),
    col.accessor((f) => f.updatedAt, {
      id: "updated",
      header: "Updated",
      cell: (c) => <span className="text-xs text-muted-foreground">{timeAgo(c.getValue(), Date.now())}</span>,
    }),
  ];

  return (
    <div className={SCREEN}>
      <SectionColumn title="Feature flags" action={newButton} widthKey="bunvex-dashboard:flags-column-width">
        {nav}
        {filters}
      </SectionColumn>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={BAR1}>
          <h1 className={BAR_TITLE}>Feature flags</h1>
          {sheet.button}
          {!list.isPending && (
            <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
              {`${formatCount(shown.length)} ${shown.length === 1 ? "flag" : "flags"}`}
            </span>
          )}
          <span className="ml-auto md:hidden">{newButton}</span>
        </div>
        <div className={BAR2}>
          <Input
            type="search"
            aria-label="Search flags"
            placeholder="Search by key or name…"
            className="h-8 w-64 max-w-full"
            value={search.q ?? ""}
            onChange={(e) => setSearch({ q: e.target.value || undefined }, true)}
          />
        </div>
        {liveError && <ErrorState error={liveError} />}
        {list.error ? (
          <ErrorState error={toDataSourceError(list.error)} />
        ) : (
          <DataTable
            label="Feature flags"
            fill
            columns={columns}
            data={shown}
            getRowId={(f) => f.key}
            defaultColumnWidth={(id) =>
              ({ key: 200, name: 220, type: 100, state: 90, serving: 220, rules: 70, updated: 130 })[id] ?? 140
            }
            grid={{
              activateOnClick: true,
              onCellActivate: (f) => setSearch({ flag: f.key, editor: undefined }),
              onCellFocus: (f) =>
                search.flag !== undefined &&
                !search.editor &&
                f.key !== search.flag &&
                setSearch({ flag: f.key }, true),
            }}
            empty={
              list.isPending
                ? "Loading…"
                : flags.length === 0
                  ? "No flags yet. Create one to ship a change gradually, or to turn it off at once."
                  : "No flag matches."
            }
          />
        )}
      </div>
      {sheet.sheet}
      {search.editor === "new" && canEdit && (
        <Panel kind="flags-details" title="New flag" onClose={() => setSearch({ editor: undefined })}>
          <FlagEditor
            existingKeys={flags.map((f) => f.key)}
            onDone={(saved) => setSearch(saved ? { editor: undefined, flag: saved } : { editor: undefined })}
          />
        </Panel>
      )}
      {search.editor !== "new" && open !== undefined && (
        <Panel
          kind="flags-details"
          title={open ? <span className="font-mono text-sm">{open.key}</span> : "Flag"}
          focusOnOpen={false}
          onClose={() => setSearch({ flag: undefined, editor: undefined })}
        >
          {open === null ? (
            <p className="text-sm text-muted-foreground">There is no flag “{search.flag}”.</p>
          ) : search.editor === "edit" && canEdit ? (
            <FlagEditor flag={open} existingKeys={[]} onDone={() => setSearch({ editor: undefined })} />
          ) : (
            <FlagDetails flag={open} canEdit={canEdit} tab={search.tab} onTab={(tab) => setSearch({ tab }, true)} />
          )}
        </Panel>
      )}
    </div>
  );
}

// a flag's state as every status is said (UX2-12): an icon and a word, never a solid pill
function StateBadge({ flag }: { flag: FeatureFlag }) {
  return <StatusBadge status={flag.archived ? "archived" : flag.enabled ? "on" : "off"} />;
}

// ------------------------------------------------------------------ a flag's details

function FlagDetails(props: {
  flag: FeatureFlag;
  canEdit: boolean;
  tab?: FlagsSearch["tab"];
  onTab: (t: NonNullable<FlagsSearch["tab"]>) => void;
}) {
  const { flag } = props;
  const [, setSearch] = useExtensionSearch<FlagsSearch>("/flags");
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto font-medium">{flag.name}</p>
        <StateBadge flag={flag} />
      </div>
      {flag.description && <p className="text-muted-foreground">{flag.description}</p>}
      {props.canEdit && <Actions flag={flag} onEdit={() => setSearch({ editor: "edit" })} />}
      <Tabs value={props.tab ?? "overview"} onValueChange={(v) => props.onTab(v as NonNullable<FlagsSearch["tab"]>)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="targeting">Targeting</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="code">Code</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="flex flex-col gap-4 pt-3">
          <Serving flag={flag} />
          <Variants flag={flag} />
          <Exposures flag={flag} />
        </TabsContent>
        <TabsContent value="targeting" className="flex flex-col gap-4 pt-3">
          <Targeting flag={flag} />
          <Preview flag={flag} />
        </TabsContent>
        <TabsContent value="history" className="pt-3">
          <History flag={flag} />
        </TabsContent>
        <TabsContent value="code" className="pt-3">
          <Code flag={flag} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Actions({ flag, onEdit }: { flag: FeatureFlag; onEdit: () => void }) {
  const scope = useQueryScope();
  const { source } = scope;
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: flagsKey(scope.scope) });
  const [error, setError] = useState<string>();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {flag.archived ? null : flag.enabled ? (
          <ConfirmButton
            label="Turn off"
            variant="destructive-outline"
            title={`Turn ${flag.key} off for everyone?`}
            description={`Everyone gets “${flag.offVariant}” at once, whatever the targeting says. You can turn it back on.`}
            confirm="Turn off"
            busy="Turning off…"
            keep="Keep it on"
            action={async () => {
              await source.setFlagEnabled!(flag.key, false);
              await refresh();
            }}
          />
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              setError(undefined);
              try {
                await source.setFlagEnabled!(flag.key, true);
                await refresh();
              } catch (e) {
                setError(toDataSourceError(e).message);
              }
            }}
          >
            Turn on
          </Button>
        )}
        {!flag.archived && (
          <Button size="sm" variant="outline" onClick={onEdit}>
            Edit
          </Button>
        )}
        {flag.archived ? (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await source.archiveFlag!(flag.key, false);
              await refresh();
            }}
          >
            Restore
          </Button>
        ) : (
          <ConfirmButton
            label="Archive"
            variant="outline"
            title={`Archive ${flag.key}?`}
            description="It is turned off and leaves the list. Code still reading it gets the off variant."
            confirm="Archive"
            busy="Archiving…"
            keep="Keep it"
            action={async () => {
              await source.archiveFlag!(flag.key, true);
              await refresh();
            }}
          />
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A rollout as one bar: each variant's share, in words too. */
function RolloutBar({ rollout }: { rollout: FlagRollout }) {
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-sm bg-muted" aria-hidden="true">
        {rollout.map((r, i) => (
          <div
            key={r.variant}
            className="h-full"
            style={{ width: `${r.weight}%`, background: `var(--series-${(i % 5) + 1})` }}
          />
        ))}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{serveText({ rollout })}</p>
    </div>
  );
}

function Serving({ flag }: { flag: FeatureFlag }) {
  return (
    <section aria-label="Serving now">
      <h3 className="mb-1 font-medium">Serving now</h3>
      {!flag.enabled ? (
        <p>
          Off: everyone gets <code className="font-mono text-xs">{flag.offVariant}</code>.
        </p>
      ) : (
        <>
          <p className="mb-2 text-muted-foreground">
            {flag.rules.length
              ? `${flag.rules.length} targeting ${flag.rules.length === 1 ? "rule" : "rules"} first, then to everyone else:`
              : "To everyone:"}
          </p>
          {"variant" in flag.fallthrough ? (
            <code className="font-mono text-xs">{flag.fallthrough.variant}</code>
          ) : (
            <RolloutBar rollout={flag.fallthrough.rollout} />
          )}
        </>
      )}
    </section>
  );
}

function Variants({ flag }: { flag: FeatureFlag }) {
  return (
    <section aria-label="Variants">
      <h3 className="mb-1 font-medium">Variants</h3>
      <ul className="divide-y border">
        {flag.variants.map((v) => (
          <li key={v.key} className="flex items-baseline gap-3 px-3 py-1.5">
            <span className="font-mono text-xs">{v.key}</span>
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {formatLiteral(v.value)}
            </code>
            {v.key === flag.offVariant && <span className="text-xs text-muted-foreground">when off</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Exposures({ flag }: { flag: FeatureFlag }) {
  const scope = useQueryScope();
  const { source } = scope;
  const ex = useQuery({
    queryKey: [...flagsKey(scope.scope), "exposures", flag.key],
    queryFn: ({ signal }) => source.flagExposures!(flag.key, lastHour(), { signal }),
    enabled: typeof source.flagExposures === "function",
    refetchInterval: 60_000,
  });
  if (typeof source.flagExposures !== "function") return null;
  return (
    <section aria-label="Exposures">
      <h3 className="mb-1 font-medium">Served, last hour</h3>
      {ex.error ? (
        <ErrorState error={toDataSourceError(ex.error)} />
      ) : !ex.data ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <LineChart
          label={`Evaluations of ${flag.key} per minute, by variant, last hour`}
          height={160}
          series={ex.data.map((e, i) => ({
            id: e.variant,
            label: e.variant,
            points: e.series,
            color: `series-${(i % 5) + 1}`,
          }))}
          formatValue={(v) => `${Math.round(v)}/min`}
        />
      )}
    </section>
  );
}

function Targeting({ flag }: { flag: FeatureFlag }) {
  return (
    <section aria-label="Targeting rules">
      <h3 className="mb-1 font-medium">Rules, in order</h3>
      {flag.rules.length === 0 ? (
        <p className="text-muted-foreground">No rules: everyone gets the default below.</p>
      ) : (
        <ol className="flex list-decimal flex-col gap-1 pl-5">
          {flag.rules.map((r) => (
            <li key={r.id}>
              {ruleText(r)}
              {r.description && <span className="text-muted-foreground"> — {r.description}</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2">
        <span className="text-muted-foreground">Default: </span>
        <code className="font-mono text-xs">{serveText(flag.fallthrough)}</code>
        <span className="text-muted-foreground"> · when off: </span>
        <code className="font-mono text-xs">{flag.offVariant}</code>
      </p>
    </section>
  );
}

/** "Who gets what": an identity's attributes, one `name=value` per line, and what the flag serves them. */
function Preview({ flag }: { flag: FeatureFlag }) {
  const id = useId();
  const [text, setText] = useState("email=ada@bunvex.dev\norg=acme\nplatform=ios\nappVersion=2.3.1");
  const identity = useMemo<FlagIdentity>(() => {
    const out: FlagIdentity = {};
    for (const line of text.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  }, [text]);
  const result = evaluate(flag, identity);
  const reason =
    result.reason === "off"
      ? "the flag is off"
      : result.reason === "rule"
        ? `rule ${flag.rules.findIndex((r) => r.id === result.ruleId) + 1} matches`
        : "no rule matches: the default";
  return (
    <section aria-label="Who gets what">
      <h3 className="mb-1 font-medium">Who gets what</h3>
      <label htmlFor={id} className="text-xs text-muted-foreground">
        An identity's attributes, one <code className="font-mono">name=value</code> per line
      </label>
      <textarea
        id={id}
        className="mt-1 h-20 w-full border bg-background p-2 font-mono text-xs"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="mt-1" aria-live="polite">
        Gets <code className="font-mono text-xs">{result.variant}</code> ({formatLiteral(result.value)}): {reason}.
      </p>
    </section>
  );
}

function History({ flag }: { flag: FeatureFlag }) {
  const scope = useQueryScope();
  const { source } = scope;
  const h = useQuery({
    queryKey: [...flagsKey(scope.scope), "history", flag.key, flag.updatedAt],
    queryFn: ({ signal }) => source.getFlagHistory!(flag.key, { signal }),
    enabled: typeof source.getFlagHistory === "function",
  });
  if (typeof source.getFlagHistory !== "function")
    return <p className="text-muted-foreground">This deployment does not keep a flag's history.</p>;
  return (
    <ul aria-label={`History of ${flag.key}`} className="divide-y border">
      {(h.data ?? []).map((c) => (
        <li key={c.id} className="flex items-baseline gap-3 px-3 py-1.5">
          <time
            dateTime={new Date(c.time).toISOString()}
            title={formatTime(c.time)}
            className="w-28 shrink-0 text-xs text-muted-foreground"
          >
            {timeAgo(c.time, Date.now())}
          </time>
          <span className="min-w-0 flex-1">{c.summary}</span>
          <span className="text-xs text-muted-foreground">{c.author ?? "unknown"}</span>
        </li>
      ))}
      {h.data?.length === 0 && <li className="px-3 py-1.5 text-muted-foreground">No changes recorded.</li>}
    </ul>
  );
}

function Code({ flag }: { flag: FeatureFlag }) {
  const snippet =
    flag.type === "boolean"
      ? `const on = useFlag("${flag.key}"); // true or false, live: it changes when the flag does`
      : `const variant = useFlag("${flag.key}"); // one of ${flag.variants.map((v) => `"${v.key}"`).join(", ")}, live`;
  const server = `const value = await ctx.flags.get("${flag.key}"); // in a query, mutation or action`;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground">
        A flag is read like a query: a client re-renders when it changes, with no polling.
      </p>
      {[snippet, server].map((s) => (
        <div key={s} className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto border bg-muted/40 p-2 font-mono text-xs">{s}</pre>
          <CopyButton text={s} label="Copy the code" iconOnly />
        </div>
      ))}
    </div>
  );
}

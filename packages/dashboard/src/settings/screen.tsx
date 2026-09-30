// Settings → Environment variables (UI-01 §14.4, STUDY-12 §9), as Convex's page: values hidden until
// shown, copy one or all as `.env` lines; add, edit, rename and delete gathered as pending changes and
// saved together (one all-or-nothing batch); a pasted `.env` file becomes new rows.
import { Button } from "@bunvex/ui/components/button";
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { Input } from "@bunvex/ui/components/input";
import { Textarea } from "@bunvex/ui/components/textarea";
import { cn } from "@bunvex/ui/lib/utils";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Plus } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, dashboardKeys, type QueryScope } from "../data/queries.ts";
import { type EnvironmentVariable, type EnvironmentVariableChange, toDataSourceError } from "../data-source.ts";
import { DashLink } from "../router.tsx";
import { ErrorState } from "../shell/error-state.tsx";
import { NotOffered } from "../shell/not-offered.tsx";
import { formatDotenv, nameProblem, parseDotenv, setProblem, valueProblem, valueWarning } from "./env-vars.ts";

export const envVarsQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: [...dashboardKeys.all(scope), "environment-variables"] as const,
    queryFn: ({ signal }) => source.listEnvironmentVariables!({ signal }),
  });

type Row = {
  key: string;
  /** What the deployment has; absent for a row being added. */
  original?: EnvironmentVariable;
  name: string;
  value: string;
  deleted: boolean;
  editing: boolean;
};

let nextKey = 0;
const newRow = (name = "", value = ""): Row => ({
  key: `new-${nextKey++}`,
  name,
  value,
  deleted: false,
  editing: true,
});
const fromServer = (vars: EnvironmentVariable[]): Row[] =>
  vars.map((v) => ({
    key: `var-${v.name}`,
    original: v,
    name: v.name,
    value: v.value,
    deleted: false,
    editing: false,
  }));

/** The batch that turns what the deployment has into what the rows say. */
export function changesOf(rows: Row[]): EnvironmentVariableChange[] {
  const out: EnvironmentVariableChange[] = [];
  for (const r of rows) {
    if (r.original) {
      const renamed = r.name !== r.original.name;
      if (r.deleted || renamed) out.push({ name: r.original.name, value: null });
      if (!r.deleted && (renamed || r.value !== r.original.value)) out.push({ name: r.name, value: r.value });
    } else if (!r.deleted) out.push({ name: r.name, value: r.value });
  }
  return out;
}

/** Per row key: what is wrong with its name or value; and the problem with the whole set. */
function validate(rows: Row[]) {
  const live = rows.filter((r) => !r.deleted);
  const counts = new Map<string, number>();
  for (const r of live) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  const name = new Map<string, string>();
  const value = new Map<string, string>();
  for (const r of live) {
    const n = nameProblem(r.name) ?? ((counts.get(r.name) ?? 0) > 1 ? `${r.name} is used twice.` : undefined);
    if (n) name.set(r.key, n);
    const v = valueProblem(r.value);
    if (v) value.set(r.key, v);
  }
  return { name, value, set: setProblem(live), ok: name.size === 0 && value.size === 0 && !setProblem(live) };
}

function SettingsLayout({ children }: { children: ReactNode }) {
  const TAB =
    "block border-l-2 border-transparent px-2 py-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground";
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <div className="flex flex-col gap-6 md:flex-row">
        <nav aria-label="Settings" className="md:w-52 md:shrink-0">
          <ul>
            <li>
              <DashLink link={{ to: "/settings/environment-variables" }} className={TAB}>
                Environment variables
              </DashLink>
            </li>
          </ul>
        </nav>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

export function EnvironmentVariablesScreen() {
  const { source } = useQueryScope();
  if (typeof source.listEnvironmentVariables !== "function")
    return <NotOffered title="Settings" what="environment variables" />;
  return (
    <SettingsLayout>
      <EnvironmentVariables />
    </SettingsLayout>
  );
}

function EnvironmentVariables() {
  const scope = useQueryScope();
  const { source } = scope;
  const queryClient = useQueryClient();
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const canView = caps?.operations.includes("viewEnvironmentVariables") ?? true;
  const canWrite =
    caps !== undefined &&
    !caps.readOnly &&
    caps.operations.includes("writeEnvironmentVariables") &&
    typeof source.updateEnvironmentVariables === "function";
  const vars = useQuery({ ...envVarsQuery(scope), enabled: canView });
  const [rows, setRows] = useState<Row[]>([]);
  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string }>();
  const focusKey = useRef<string>(undefined);
  // what the deployment has replaces the rows when it (re)loads
  useEffect(() => {
    if (vars.data) setRows(fromServer(vars.data));
  }, [vars.data]);
  const changes = useMemo(() => changesOf(rows), [rows]);
  const problems = useMemo(() => validate(rows), [rows]);
  const update = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const titleId = useId();

  if (!canView)
    return <p className="text-sm text-muted-foreground">This credential cannot view environment variables.</p>;
  if (vars.error) return <ErrorState error={toDataSourceError(vars.error)} />;
  if (!vars.data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const add = (added: Row[]) => {
    focusKey.current = added[0]?.key;
    setRows((rs) => [...rs, ...added]);
    setOutcome(undefined);
  };
  const save = async () => {
    setSaving(true);
    setOutcome(undefined);
    try {
      await source.updateEnvironmentVariables!(changes);
      const n = changes.length;
      setOutcome({ ok: true, message: `Saved ${n} ${n === 1 ? "change" : "changes"}.` });
      await queryClient.invalidateQueries({ queryKey: envVarsQuery(scope).queryKey });
    } catch (e) {
      setOutcome({ ok: false, message: `Could not save: ${toDataSourceError(e).message}` });
    }
    setSaving(false);
  };

  return (
    <section aria-labelledby={titleId} className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={titleId} className="text-lg font-medium">
          Environment variables
        </h2>
        <span className="ml-auto" />
        {vars.data.length > 0 && <CopyButton text={formatDotenv(vars.data)} label="Copy all as .env" />}
      </div>
      <p className="text-sm text-muted-foreground">
        Functions read them with <code className="font-mono text-xs">process.env.NAME</code>. Changes apply to functions
        that start after they are saved.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No environment variables yet.</p>
      ) : (
        <ul aria-label="Environment variables" className="flex flex-col divide-y border">
          {rows.map((r) => (
            <li key={r.key} className={cn("flex flex-col gap-2 p-3", r.deleted && "bg-destructive/5")}>
              {r.editing ? (
                <EditRow
                  row={r}
                  autoFocus={focusKey.current === r.key}
                  nameError={problems.name.get(r.key)}
                  valueError={problems.value.get(r.key)}
                  onChange={(patch) => update(r.key, patch)}
                  onPaste={(parsed) => {
                    // a pasted .env file: its lines become new rows in place of this empty one
                    setRows((rs) => [
                      ...rs.filter((x) => x.key !== r.key),
                      ...parsed.map((p) => newRow(p.name, p.value)),
                    ]);
                  }}
                  onDone={() => update(r.key, { editing: false })}
                  onRevert={() =>
                    r.original
                      ? update(r.key, { name: r.original.name, value: r.original.value, editing: false })
                      : setRows((rs) => rs.filter((x) => x.key !== r.key))
                  }
                />
              ) : (
                <ViewRow
                  row={r}
                  shown={shown.has(r.key)}
                  canWrite={canWrite}
                  onToggle={() =>
                    setShown((s) => {
                      const next = new Set(s);
                      if (!next.delete(r.key)) next.add(r.key);
                      return next;
                    })
                  }
                  onEdit={() => update(r.key, { editing: true })}
                  onDelete={() => update(r.key, { deleted: !r.deleted })}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <div>
          <Button size="sm" variant="outline" onClick={() => add([newRow()])}>
            <Plus aria-hidden="true" />
            Add a variable
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            Tip: paste a .env file into a name box to add all its lines.
          </p>
        </div>
      )}
      {problems.set && (
        <p role="alert" className="text-sm text-destructive">
          {problems.set}
        </p>
      )}
      {changes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border bg-muted/40 p-3">
          <span className="text-sm">
            {changes.length} unsaved {changes.length === 1 ? "change" : "changes"}
          </span>
          <span className="ml-auto" />
          <Button size="sm" variant="outline" disabled={saving} onClick={() => setRows(fromServer(vars.data))}>
            Discard
          </Button>
          <Button size="sm" disabled={saving || !problems.ok} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
      <p role={outcome && !outcome.ok ? "alert" : "status"} className="min-h-5 text-sm">
        <span className={outcome?.ok === false ? "text-destructive" : "text-muted-foreground"}>{outcome?.message}</span>
      </p>
    </section>
  );
}

function ViewRow(props: {
  row: Row;
  shown: boolean;
  canWrite: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { row } = props;
  const changed = row.original && (row.name !== row.original.name || row.value !== row.original.value);
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
      <span className={cn("min-w-48 font-mono text-sm font-medium break-all", row.deleted && "line-through")}>
        {row.name}
      </span>
      <span className="min-w-0 flex-1 font-mono text-xs break-all whitespace-pre-wrap">
        {props.shown ? (
          row.value
        ) : (
          <>
            <span aria-hidden="true">••••••••••••</span>
            <span className="sr-only">Hidden value</span>
          </>
        )}
      </span>
      {row.deleted && <span className="text-xs text-destructive">Deleted when you save</span>}
      {changed && !row.deleted && <span className="text-xs text-info">Changed</span>}
      <span className="flex gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-pressed={props.shown}
          aria-label={props.shown ? `Hide the value of ${row.name}` : `Show the value of ${row.name}`}
          onClick={props.onToggle}
        >
          {props.shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </Button>
        <CopyButton text={`${row.name}=${row.value}`} label={`Copy ${row.name}`} size="sm" variant="ghost" />
        {props.canWrite && !row.deleted && (
          <Button size="sm" variant="ghost" aria-label={`Edit ${row.name}`} onClick={props.onEdit}>
            Edit
          </Button>
        )}
        {props.canWrite && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${row.deleted ? "Keep" : "Delete"} ${row.name}`}
            onClick={props.onDelete}
          >
            {row.deleted ? "Undo" : "Delete"}
          </Button>
        )}
      </span>
    </div>
  );
}

function EditRow(props: {
  row: Row;
  autoFocus: boolean;
  nameError?: string;
  valueError?: string;
  onChange: (patch: Partial<Row>) => void;
  onPaste: (vars: { name: string; value: string }[]) => void;
  onDone: () => void;
  onRevert: () => void;
}) {
  const { row } = props;
  const nameId = useId();
  const valueId = useId();
  const nameErrId = useId();
  const valueErrId = useId();
  const warning = valueWarning(row.value);
  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="flex min-w-48 flex-col gap-1">
        <label htmlFor={nameId} className="text-xs text-muted-foreground">
          Name
        </label>
        <Input
          id={nameId}
          className="h-8 font-mono text-xs"
          value={row.name}
          autoFocus={props.autoFocus}
          aria-invalid={props.nameError ? true : undefined}
          aria-describedby={props.nameError ? nameErrId : undefined}
          onChange={(e) => props.onChange({ name: e.target.value })}
          onPaste={(e) => {
            const parsed = parseDotenv(e.clipboardData.getData("text"));
            if (!parsed || row.original) return;
            e.preventDefault();
            props.onPaste(parsed);
          }}
        />
        {props.nameError && (
          <span id={nameErrId} className="text-xs text-destructive">
            {props.nameError}
          </span>
        )}
      </div>
      <div className="flex min-w-64 flex-1 flex-col gap-1">
        <label htmlFor={valueId} className="text-xs text-muted-foreground">
          Value
        </label>
        <Textarea
          id={valueId}
          rows={1}
          className="min-h-8 font-mono text-xs"
          value={row.value}
          aria-invalid={props.valueError ? true : undefined}
          aria-describedby={props.valueError || warning ? valueErrId : undefined}
          onChange={(e) => props.onChange({ value: e.target.value })}
        />
        {(props.valueError || warning) && (
          <span id={valueErrId} className={cn("text-xs", props.valueError ? "text-destructive" : "text-warning")}>
            {props.valueError ?? warning}
          </span>
        )}
      </div>
      <span className="flex gap-1 pt-5">
        <Button size="sm" variant="outline" disabled={!!props.nameError || !!props.valueError} onClick={props.onDone}>
          Done
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onRevert}>
          {row.original ? "Revert" : "Remove"}
        </Button>
      </span>
    </div>
  );
}

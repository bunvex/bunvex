// `bunvex deployment usage` and `bunvex deployment usage-limits list|set|remove` (STUDY-118): Convex's
// `npx convex deployment usage` / `usage-limits` (npm-packages/convex/src/cli/usageLimits.ts,
// lib/usageLimits.ts), against the deployment's `/api/v1/*usage*` routes (STUDY-61). Convex's tables, number
// formats, ordering and messages: tables and JSON on stdout, the rest on stderr. A limit is named by its
// (metric, window, type); `set` creates it or updates the one there. Convex's other `deployment` commands
// (create, select, token, …) are for its cloud.
import type { Io } from "./io.ts";
import { acquireTarget } from "./local-deployment.ts";
import { NO_DEPLOYMENT, TARGET_OPTIONS, type Target, takeTargetFlags } from "./target.ts";

/** Convex's `--metric` choices, in its order, with the isolate actions' metric renamed (DV-308). */
export const USAGE_LIMIT_METRICS = [
  "functionCalls",
  "queryMutationComputeGbHours",
  "actionComputeIsolateGbHours",
  "actionComputeNodeJsGbHours",
  "actionComputeCpuGbHours",
  "databaseIoGb",
  "searchQueryGb",
  "dataEgressGb",
] as const;
export const DEPLOYMENT_USAGE = `Usage: bunvex deployment <command> [options]

Commands:
  usage                show usage so far in the current day and calendar month for every metric
  usage-limits list    list the usage limits configured on the deployment
  usage-limits set     create a usage limit, or update the one for the same (metric, window, type)
  usage-limits remove  delete a usage limit, identified by its (metric, window, type) (aliases: rm, delete)

Options:
${TARGET_OPTIONS}
  --json               usage, usage-limits list: print JSON
  --metric <metric>    set, remove: the metric to limit (${USAGE_LIMIT_METRICS.join(", ")})
  --window <window>    set, remove: day or month, the window the limit is measured over
  --type <type>        set, remove: \`warning\` only notifies; \`disable\` pauses the deployment when exceeded
  --limit <limit>      set: the limit, in the metric's native units; required when creating, kept as is when
                       omitted while updating
  --active             set: enforce the limit (the default for a new limit)
  --inactive           set: create or leave the limit unenforced`;

const WINDOWS = ["day", "month"] as const;
const TYPES = ["warning", "disable"] as const;

const METRIC_LABELS: Record<string, string> = {
  functionCalls: "Function calls",
  queryMutationComputeGbHours: "Query/Mutation compute",
  actionComputeIsolateGbHours: "Action compute",
  actionComputeNodeJsGbHours: "Action compute (Node.js)",
  actionComputeCpuGbHours: "Action compute (CPU)",
  databaseIoGb: "Database I/O",
  searchQueryGb: "Search queries",
  dataEgressGb: "Data egress",
};
/** A metric's label; one this CLI does not know (as `aiGatewayCostDollars`) shows its name, as Convex's. */
const metricLabel = (metric: string) => METRIC_LABELS[metric] ?? metric;

// Convex's order: metrics as listed (unknown ones last, in their order), month before day, warning before disable.
const metricRank = (m: string) => {
  const i = (USAGE_LIMIT_METRICS as readonly string[]).indexOf(m);
  return i === -1 ? USAGE_LIMIT_METRICS.length : i;
};
type Key = { metric: string; window: string; limitType: string };
const compareLimits = (a: Key, b: Key) =>
  metricRank(a.metric) - metricRank(b.metric) ||
  (a.window === "month" ? 0 : 1) - (b.window === "month" ? 0 : 1) ||
  (a.limitType === "warning" ? 0 : 1) - (b.limitType === "warning" ? 0 : 1);

type UsageLimit = Key & { id: string; limit: number; enabled: boolean };
type CurrentUsage = {
  metrics: Record<string, { unit: string; usage: { current_day: number; current_month: number } }>;
  seedStatus: "complete" | "pending" | "partial" | "failed";
};

// ---------------------------------------------------------------- formatting, as Convex's

const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 3,
});
const EXACT = new Intl.NumberFormat("en-US");
const noNegativeZero = (s: string) => (s === "-0" ? "0" : s);
/** A table's amount: compact (`1.235M`), with the unit (`call` for one call). */
const amount = (value: number, unit: string | null) => {
  const n = noNegativeZero(COMPACT.format(value));
  return unit === null ? n : `${n} ${value === 1 && unit === "calls" ? "call" : unit}`;
};
/** A message's amount: exact, with thousands separators. */
const exact = (value: number) => EXACT.format(value);

/** Convex's box-drawn table; `right` are the right-aligned columns. */
export function formatTable(header: string[], rows: string[][], right: number[] = []): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (cell: string, i: number) => (right.includes(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!));
  const rule = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const line = (cells: string[]) => `│ ${cells.map((c, i) => pad(c ?? "", i)).join(" │ ")} │`;
  return [rule("┌", "┬", "┐"), line(header), rule("├", "┼", "┤"), ...rows.map(line), rule("└", "┴", "┘")].join("\n");
}

const seedStatusMessage = (s: CurrentUsage["seedStatus"]) =>
  s === "failed"
    ? "We couldn't load this deployment's historical usage, so the usage shown below may understate its actual usage. Limits are still enforced going forward."
    : "Historical usage is still being loaded, so the usage shown below may understate this deployment's actual usage. Check back shortly for accurate totals.";

// ---------------------------------------------------------------- the commands

/** A failure printed as Convex's `ctx.crash` prints it: `✖ <message>`, exit 1. */
class Failure extends Error {}

/**
 * A request to `/api/v1/<path>` (POST with a body or `post`, else GET), as Convex's `usageLimitFetch`. A failure
 * reads as Convex's `ThrowingFetchError`: `<status> <statusText>: <code>: <message>`, or the server's message
 * alone for a 403.
 */
async function request(t: Target, path: string, o: { body?: object; post?: boolean } = {}): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(`${t.url}/api/v1${path}`, {
      method: o.post || o.body ? "POST" : "GET",
      headers: { "content-type": "application/json", authorization: `Bunvex ${t.adminKey}` },
      ...(o.body ? { body: JSON.stringify(o.body) } : {}),
    });
  } catch (e) {
    throw new Failure(String(e));
  }
  const text = await r.text();
  if (r.ok) return text.length ? JSON.parse(text) : undefined;
  let code: string | undefined;
  let message: string | undefined;
  try {
    ({ code, message } = JSON.parse(text) as { code?: string; message?: string });
  } catch {
    // The status is the error.
  }
  const status = `${r.status} ${r.statusText}`;
  if (r.status === 403 && message !== undefined) throw new Failure(message);
  throw new Failure(code !== undefined && message !== undefined ? `${status}: ${code}: ${message}` : status);
}

const listLimits = async (t: Target) =>
  ((await request(t, "/list_usage_limits")) as { usageLimits: UsageLimit[] }).usageLimits;
const currentUsage = async (t: Target) => (await request(t, "/get_current_usage")) as CurrentUsage;

async function usage(t: Target, io: Io, json: boolean) {
  const u = await currentUsage(t);
  if (json) return io.out(JSON.stringify(u, null, 2));
  if (u.seedStatus !== "complete") io.err(seedStatusMessage(u.seedStatus));
  io.out(
    formatTable(
      ["Metric", "Day", "Month"],
      Object.entries(u.metrics)
        .sort(([a], [b]) => metricRank(a) - metricRank(b))
        .map(([m, { unit, usage }]) => [
          metricLabel(m),
          amount(usage.current_day, unit),
          amount(usage.current_month, unit),
        ]),
    ),
  );
}

async function list(t: Target, io: Io, json: boolean) {
  const [limits, u] = await Promise.all([listLimits(t), currentUsage(t)]);
  const withStatus = limits
    .map((l) => {
      const m = u.metrics[l.metric];
      const currentUsage = m === undefined ? null : l.window === "day" ? m.usage.current_day : m.usage.current_month;
      const triggered = l.enabled && currentUsage !== null && currentUsage >= l.limit;
      return { ...l, currentUsage, unit: m?.unit ?? null, triggered };
    })
    .sort(compareLimits);
  if (json) return io.out(JSON.stringify(withStatus, null, 2));
  if (!withStatus.length) return io.err("No usage limits configured.");
  // "Triggered" comes from the reported usage, which an incomplete history may understate.
  if (u.seedStatus !== "complete") io.err(seedStatusMessage(u.seedStatus));
  io.out(
    formatTable(
      ["Metric", "Window", "Type", "Limit", "Current Usage", "Active", "Triggered"],
      withStatus.map((l) => [
        metricLabel(l.metric),
        l.window,
        l.limitType,
        amount(l.limit, l.unit),
        l.currentUsage === null
          ? "—"
          : `${amount(l.currentUsage, l.unit)} (${noNegativeZero(EXACT.format(Math.round((l.currentUsage / l.limit) * 100)))}%)`,
        l.enabled ? "yes" : "no",
        l.triggered ? "yes" : "no",
      ]),
      [3, 4],
    ),
  );
}

type SetOptions = Key & { limit?: number; active: boolean; inactive: boolean };

async function set(t: Target, io: Io, o: SetOptions) {
  const existing = (await listLimits(t)).find(
    (l) => l.metric === o.metric && l.window === o.window && l.limitType === o.limitType,
  );
  const label = `${o.limitType} usage limit on ${metricLabel(o.metric)} per ${o.window}`;
  const state = (enabled: boolean) => (enabled ? "active" : "inactive");
  if (existing === undefined) {
    if (o.limit === undefined) throw new Failure("error: --limit is required when creating a usage limit.");
    const created = (
      (await request(t, "/create_usage_limit", {
        body: { metric: o.metric, window: o.window, limitType: o.limitType, limit: o.limit, enabled: !o.inactive },
      })) as { usageLimit: UsageLimit }
    ).usageLimit;
    return io.err(`✔ Created ${label}: ${exact(created.limit)}, ${state(created.enabled)}.`);
  }
  const enabled = o.active ? true : o.inactive ? false : existing.enabled;
  const limit = o.limit ?? existing.limit;
  const changes: string[] = [];
  if (limit !== existing.limit) changes.push(`limit ${exact(existing.limit)} → ${exact(limit)}`);
  if (enabled !== existing.enabled) changes.push(`${state(existing.enabled)} → ${state(enabled)}`);
  if (!changes.length)
    return io.err(`✔ No changes to ${label} (${exact(existing.limit)}, ${state(existing.enabled)}).`);
  await request(t, `/update_usage_limit/${encodeURIComponent(existing.id)}`, {
    body: { metric: existing.metric, window: existing.window, limitType: existing.limitType, limit, enabled },
  });
  io.err(`✔ Updated ${label}: ${changes.join(", ")}.`);
}

async function remove(t: Target, io: Io, k: Key) {
  const existing = (await listLimits(t)).find(
    (l) => l.metric === k.metric && l.window === k.window && l.limitType === k.limitType,
  );
  if (!existing) throw new Failure(`error: No ${k.limitType} usage limit on ${k.metric} per ${k.window}.`);
  await request(t, `/delete_usage_limit/${encodeURIComponent(existing.id)}`, { post: true });
  io.err(`✔ Deleted ${existing.limitType} usage limit on ${metricLabel(existing.metric)} per ${existing.window}.`);
}

// ---------------------------------------------------------------- arguments

const VALUE_FLAGS = ["--metric", "--window", "--type", "--limit"] as const;
const BOOLEAN_FLAGS = ["--json", "--active", "--inactive"] as const;

/** `bunvex deployment …`; resolves to the exit code. */
export async function deploymentCommand(args: string[], io: Io): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.out(DEPLOYMENT_USAGE);
    return args.length === 0 ? 1 : 0;
  }
  const taken = takeTargetFlags(args);
  const fail = (message: string) => {
    io.err(`bunvex deployment: ${message}`);
    return 2;
  };
  if (typeof taken === "string") return fail(taken);
  const words: string[] = [];
  const values: Partial<Record<(typeof VALUE_FLAGS)[number], string>> = {};
  const flags = new Set<string>();
  const r = taken.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : r[++i];
      if (v === undefined) return fail(`option '${name} <${name.slice(2)}>' argument missing`);
      values[name as (typeof VALUE_FLAGS)[number]] = v;
    } else if ((BOOLEAN_FLAGS as readonly string[]).includes(a)) flags.add(a);
    else if (a.startsWith("-")) return fail(`unknown option ${a}\n\n${DEPLOYMENT_USAGE}`);
    else words.push(a);
  }
  const [group, sub, ...extra] = words;
  const command =
    group === "usage" && sub === undefined
      ? "usage"
      : group === "usage-limits" && sub !== undefined && extra.length === 0
        ? ({ list: "list", set: "set", remove: "remove", rm: "remove", delete: "remove" } as const)[sub]
        : undefined;
  if (command === undefined) return fail(`unknown command ${words.join(" ")}\n\n${DEPLOYMENT_USAGE}`);
  // Each command's own options, as Convex's: anything else is an unknown option.
  const allowed: Record<typeof command, string[]> = {
    usage: ["--json"],
    list: ["--json"],
    set: ["--metric", "--window", "--type", "--limit", "--active", "--inactive"],
    remove: ["--metric", "--window", "--type"],
  };
  for (const f of [...flags, ...Object.keys(values)])
    if (!allowed[command].includes(f)) return fail(`unknown option ${f}\n\n${DEPLOYMENT_USAGE}`);
  // `set` and `remove` need the (metric, window, type), each one of its choices.
  const choice = (flag: "--metric" | "--window" | "--type", choices: readonly string[]) => {
    const v = values[flag];
    const spec = `${flag} <${flag.slice(2)}>`;
    if (v === undefined) return `required option '${spec}' not specified`;
    if (!choices.includes(v))
      return `option '${spec}' argument '${v}' is invalid. Allowed choices are ${choices.join(", ")}.`;
    return null;
  };
  let key: Key | undefined;
  if (command === "set" || command === "remove") {
    for (const [flag, choices] of [
      ["--metric", USAGE_LIMIT_METRICS],
      ["--window", WINDOWS],
      ["--type", TYPES],
    ] as const) {
      const problem = choice(flag, choices);
      if (problem) return fail(problem);
    }
    key = { metric: values["--metric"]!, window: values["--window"]!, limitType: values["--type"]! };
  }
  // Convex's checks before it talks to the deployment.
  let limit: number | undefined;
  if (command === "set") {
    if (flags.has("--active") && flags.has("--inactive")) {
      io.err("✖ error: Pass at most one of --active and --inactive.");
      return 1;
    }
    const raw = values["--limit"];
    if (raw !== undefined) {
      limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 1) {
        io.err(`✖ error: --limit must be a positive integer, got "${raw}".`);
        return 1;
      }
    }
  }
  let acquired: Awaited<ReturnType<typeof acquireTarget>>;
  try {
    acquired = await acquireTarget(taken.flags, io);
  } catch (e) {
    io.err(`bunvex deployment: ${(e as Error).message}`);
    return 1;
  }
  if (!acquired) {
    io.err(`bunvex deployment: ${NO_DEPLOYMENT}`);
    return 1;
  }
  try {
    const json = flags.has("--json");
    if (command === "usage") await usage(acquired.target, io, json);
    else if (command === "list") await list(acquired.target, io, json);
    else if (command === "set")
      await set(acquired.target, io, {
        ...key!,
        limit,
        active: flags.has("--active"),
        inactive: flags.has("--inactive"),
      });
    else await remove(acquired.target, io, key!);
    return 0;
  } catch (e) {
    io.err(`✖ ${(e as Error).message}`);
    return 1;
  } finally {
    await acquired.release();
  }
}

// A client group's details beside the Topology screen (UI-01 §33): its live connections, which nodes serve
// them, the app versions they run and the SDK versions they use — each SDK version with its state under the
// deployment's policy (upgrade required, unsupported), as Convex says a client's version state.
import { StatusBadge } from "@bunvex/ui/components/status-badge";
import { type ClientGroup, PLATFORM_LABEL, PlatformIcon } from "../clients/words.tsx";
import { type ClientPolicy, sdkState } from "../data-source-clients.ts";
import { formatCount, formatPercent } from "../screens/stats.ts";
import { Panel } from "../shell/panel.tsx";

/** Rows of a breakdown: a name, its connections and its share, most first. */
function Breakdown({
  label,
  rows,
  total,
}: {
  label: string;
  rows: { name: string; connections: number; extra?: React.ReactNode }[];
  total: number;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {rows.map((r) => (
          <li key={r.name} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.name}</span>
              {r.extra}
              <span className="font-mono text-xs tabular-nums">{formatCount(r.connections)}</span>
              <span className="w-10 text-right font-mono text-xs text-muted-foreground tabular-nums">
                {formatPercent(total ? r.connections / total : 0)}
              </span>
            </span>
            <span aria-hidden="true" className="block h-[3px] bg-muted">
              <span
                className="block h-full bg-muted-foreground/50"
                style={{ width: `${total ? (r.connections / total) * 100 : 0}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const sumBy = <T,>(items: T[], key: (t: T) => string | undefined, value: (t: T) => number) => {
  const m = new Map<string, number>();
  for (const i of items) {
    const k = key(i);
    if (k !== undefined) m.set(k, (m.get(k) ?? 0) + value(i));
  }
  return [...m].map(([name, connections]) => ({ name, connections })).sort((a, b) => b.connections - a.connections);
};

export function ClientsPanel({
  group: g,
  policy,
  onClose,
}: {
  group: ClientGroup;
  policy?: ClientPolicy;
  onClose: () => void;
}) {
  const appVersions = sumBy(
    g.buckets,
    (b) => b.appVersion,
    (b) => b.connections,
  );
  const sdk = sumBy(
    g.buckets,
    (b) => `${b.platform}|${b.sdkVersion}`,
    (b) => b.connections,
  ).map((r) => {
    const [platform, version] = r.name.split("|") as [keyof typeof PLATFORM_LABEL, string];
    const state = policy ? sdkState(platform, version, policy) : undefined;
    return {
      name: `${PLATFORM_LABEL[platform]} SDK ${version}`,
      connections: r.connections,
      extra: state && state !== "supported" ? <StatusBadge status={state} /> : undefined,
    };
  });
  return (
    <Panel
      kind="topology-clients"
      title={
        <span className="flex items-center gap-2">
          <PlatformIcon platform={g.platform} className="size-4" />
          {g.label}
        </span>
      }
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          <span className="font-mono tabular-nums">{formatCount(g.connections)}</span> live connections
        </p>
        <Breakdown
          label="Served by"
          rows={g.perNode.map((p) => ({ name: p.node, connections: p.connections }))}
          total={g.connections}
        />
        {appVersions.length > 0 && <Breakdown label="App versions" rows={appVersions} total={g.connections} />}
        <Breakdown label="SDK versions" rows={sdk} total={g.connections} />
      </div>
    </Panel>
  );
}

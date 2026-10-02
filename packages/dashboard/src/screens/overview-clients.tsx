// The Overview's "Clients" block (UI-01 §33): who is connected right now — by platform, as a share of the live
// connections — and the SDK versions in use, each with its state under the deployment's policy (as Convex says
// a client's version state: upgrade required, unsupported). Loaded with the block, out of the first load.
import { StatusBadge } from "@bunvex/ui/components/status-badge";
import { PLATFORM_LABEL, PlatformIcon } from "../clients/words.tsx";
import type { ClientSummary } from "../data-source-clients.ts";
import { DashLink } from "../router.tsx";
import { formatCount, formatPercent } from "./stats.ts";

export function ClientsBlock({ summary: s }: { summary: ClientSummary }) {
  const outdated = s.sdkVersions.filter((v) => v.state !== "supported");
  return (
    <div className="mt-3 grid min-h-52 grid-cols-1 gap-6 border p-4 lg:grid-cols-2" data-testid="overview-clients">
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-sm">
          <span className="font-mono tabular-nums">{formatCount(s.connections)}</span> live connections
        </p>
        {/* the shares as one bar, each platform also listed in words below */}
        <div aria-hidden="true" className="flex h-2 w-full gap-px bg-background">
          {s.byPlatform.map((p, i) => (
            <span
              key={p.platform}
              className="h-full"
              style={{
                width: `${(p.connections / Math.max(1, s.connections)) * 100}%`,
                background: `color-mix(in oklch, var(--color-info) ${100 - i * 14}%, var(--color-muted))`,
              }}
            />
          ))}
        </div>
        <ul aria-label="Connections by platform" className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          {s.byPlatform.map((p) => (
            <li key={p.platform} className="flex items-center gap-1.5">
              <PlatformIcon platform={p.platform} />
              <span className="min-w-0 flex-1 truncate">{PLATFORM_LABEL[p.platform]}</span>
              <span className="font-mono text-xs tabular-nums">{formatCount(p.connections)}</span>
              <span className="w-9 text-right font-mono text-xs text-muted-foreground tabular-nums">
                {formatPercent(p.connections / Math.max(1, s.connections))}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">SDK versions in use</h3>
        <ul aria-label="SDK versions in use" className="flex flex-col gap-1 text-sm">
          {s.sdkVersions.slice(0, 8).map((v) => (
            <li key={`${v.platform}|${v.version}`} className="flex items-center gap-2">
              <PlatformIcon platform={v.platform} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {v.sdk} {v.version}
              </span>
              {v.state !== "supported" && <StatusBadge status={v.state} />}
              <span className="font-mono text-xs tabular-nums">{formatCount(v.connections)}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          {outdated.length === 0
            ? "Every client runs a supported SDK."
            : `${formatCount(outdated.reduce((a, v) => a + v.connections, 0))} connections run an outdated SDK.`}{" "}
          <DashLink link={{ to: "/topology" }} className="underline underline-offset-2">
            See them in Topology
          </DashLink>
        </p>
      </div>
    </div>
  );
}

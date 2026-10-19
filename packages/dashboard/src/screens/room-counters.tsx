// The rooms' gauges and counters (AD-43, STUDY-165 §3.2), in the Overview's collapsed "Rooms" section: the open
// rooms, their members and connections now, and the counters since the server started with their rate per second
// between the last two samples. Read with `getStats` every second while the section is open (STUDY-165 D5), not
// while the tab is hidden (TanStack Query's default for an interval) nor while the deployment is disconnected.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { dashboardKeys } from "../data/queries.ts";
import { type DeploymentStats, toDataSourceError } from "../data-source.ts";
import { ROOMS_POLL_MS } from "../rooms/words.ts";
import { useDisconnected } from "../shell/connection.tsx";
import { ErrorState } from "../shell/error-state.tsx";
import { Counter } from "./engine.tsx";
import { type RoomCounter, roomDelta, roomRate } from "./room-stats.ts";
import { appendSample, formatCount, formatRate } from "./stats.ts";

export function RoomCounters() {
  const scope = useQueryScope();
  const disconnected = useDisconnected();
  const q = useQuery({
    queryKey: [...dashboardKeys.all(scope.scope), "rooms", "stats"] as const,
    queryFn: ({ signal }) => scope.source.getStats({ signal }),
    enabled: !disconnected,
    refetchInterval: ROOMS_POLL_MS,
  });
  // the last two samples, for the rates
  const [samples, setSamples] = useState<DeploymentStats[]>([]);
  useEffect(() => {
    if (q.data) setSamples((h) => appendSample(h, q.data, 2));
  }, [q.data]);
  const cur = samples.at(-1);
  const prev = samples.at(-2);
  if (q.error && !cur) return <ErrorState error={toDataSourceError(q.error)} onRetry={() => void q.refetch()} />;
  if (!cur?.rooms) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const r = cur.rooms;
  const perSecond = (c: RoomCounter) => (prev ? `${formatRate(roomRate(prev, cur, c))}/s` : "…/s");
  const dropped = (c: RoomCounter, what: string) => {
    const n = roomDelta(prev, cur, c);
    return n > 0 ? `${formatCount(n)} ${what} dropped since the last sample` : undefined;
  };
  return (
    <section aria-labelledby="room-counters">
      <h2 id="room-counters" className="sr-only">
        Rooms now, and counters since the server started
      </h2>
      <dl className="grid grid-cols-1 gap-px border bg-border sm:grid-cols-2 lg:grid-cols-3">
        <Counter label="Open rooms" value={formatCount(r.rooms)} detail="Rooms and presence scopes, now" />
        <Counter label="Members" value={formatCount(r.members)} detail="Across every open room, now" />
        <Counter label="Connections" value={formatCount(r.connections)} detail="Of those members, now" />
        <Counter
          label="Joins"
          value={formatCount(r.joins)}
          detail={`${perSecond("joins")} · refused: ${formatCount(r.joinsRefusedByGate)} by a gate, ${formatCount(r.joinsRefusedByLimit)} by a limit`}
        />
        <Counter
          label="Leaves"
          value={formatCount(r.leaves)}
          detail={`${perSecond("leaves")} · ${formatCount(r.graceExpiries)} after the reconnect grace ran out`}
        />
        <Counter
          label="Presence updates"
          value={formatCount(r.presenceAccepted)}
          detail={`${perSecond("presenceAccepted")} · ${formatCount(r.presenceDropped)} dropped by the rate limit`}
          status={dropped("presenceDropped", "presence updates")}
        />
        <Counter
          label="Events"
          value={formatCount(r.eventsAccepted)}
          detail={`${perSecond("eventsAccepted")} · ${formatCount(r.eventsDropped)} dropped by the rate limit`}
          status={dropped("eventsDropped", "events")}
        />
        <Counter
          label="Resyncs"
          value={formatCount(r.resyncs)}
          detail={`${perSecond("resyncs")} · connections closed for falling behind`}
        />
        <Counter
          label="Memberships ended"
          value={formatCount(r.roomLeft)}
          detail={`${perSecond("roomLeft")} · RoomLeft sent by the server`}
        />
      </dl>
    </section>
  );
}

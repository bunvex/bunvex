// The Rooms screen (AD-43, STUDY-165 §5.1) — a bunvex addition: Convex has no rooms. The rooms and presence scopes
// open now, as the hub keeps them in memory (STUDY-164 §3.5): by definition, then args, with their members,
// connections and when they opened; filtered by definition and sorted by members from the URL. A room opens in the
// side panel with its members, a page of 100 at a time, each with its presence or state. Polled every second while
// the screen is open (D5), not while the tab is hidden (TanStack Query's default for an interval) nor while the
// deployment is disconnected (STUDY-149 PR 6's rule for polled reads). A room that leaves the list has closed (its
// last member left): the panel says so and keeps what it last showed. A deployment without rooms answers
// `not_found`, which is an empty state, not an error.
import { Badge } from "@bunvex/ui/components/badge";
import { Button } from "@bunvex/ui/components/button";
import { ChoiceSelect } from "@bunvex/ui/components/choice-select";
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { cn } from "@bunvex/ui/lib/utils";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useId, useRef } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, dashboardKeys } from "../data/queries.ts";
import { type RoomInfo, type RoomMember, toDataSourceError } from "../data-source.ts";
import { LiteralView } from "../database/literal-view.tsx";
import { type RoomsSearch, roomsRoute } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";
import { BAR_TITLE, BAR1, BAR2, SCREEN } from "../shell/bars.ts";
import { useDisconnected } from "../shell/connection.tsx";
import { ErrorState } from "../shell/error-state.tsx";
import { NotOffered } from "../shell/not-offered.tsx";
import { Panel } from "../shell/panel.tsx";
import { formatTime, RelativeTime } from "../shell/time.tsx";
import { KIND_LABEL, openedRoom, ROOMS_POLL_MS, roomNames, roomsSummary, shortValue, shownRooms } from "./words.ts";

/** A members page: the most the server returns in one. */
export const MEMBERS_PAGE = 100;
/** What a deployment without rooms answers (`not_found`), said as the screen's empty state. */
export const NO_ROOMS = "This deployment does not run rooms.";
const ALL = "__all";

export function RoomsScreen() {
  const { source } = useQueryScope();
  if (typeof source.listRooms !== "function")
    return <NotOffered title="Rooms" what="a view of its rooms and presence scopes" />;
  return <Rooms />;
}

const col = dataTableColumns<RoomInfo>();

function Rooms() {
  const scope = useQueryScope();
  const { source } = scope;
  const search = roomsRoute.useSearch();
  const navigate = roomsRoute.useNavigate();
  const setSearch = (patch: Partial<RoomsSearch>, replace = false) =>
    navigate({ search: (s: RoomsSearch): RoomsSearch => ({ ...s, ...patch }), replace });
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const allowed = caps?.operations.includes("viewMetrics") ?? true;
  const disconnected = useDisconnected();
  const list = useQuery({
    queryKey: [...dashboardKeys.all(scope.scope), "rooms"] as const,
    queryFn: ({ signal }) => source.listRooms!({ signal }),
    enabled: allowed && !disconnected,
    refetchInterval: ROOMS_POLL_MS,
    placeholderData: keepPreviousData,
  });
  const error = list.error ? toDataSourceError(list.error) : undefined;
  const noRooms = error?.code === "not_found";
  const rooms = list.data ?? [];
  const by = search.sort === "members" ? "members" : "name";
  const shown = shownRooms(rooms, search.name, by);
  const names = roomNames(rooms);
  const filterId = useId();

  // the open room as last listed: what the panel keeps showing once it closes
  const seen = useRef<RoomInfo>(undefined);
  const opened =
    search.room === undefined || list.data === undefined ? undefined : openedRoom(search.room, rooms, seen.current);
  if (opened?.state === "open") seen.current = opened.room;

  const columns: DataTableColumn<RoomInfo>[] = [
    col.accessor((r) => r.name, {
      id: "name",
      header: "Definition",
      cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span>,
    }),
    col.accessor((r) => KIND_LABEL[r.kind], { id: "kind", header: "Kind" }),
    col.accessor((r) => shortValue(r.args), {
      id: "args",
      header: "Args",
      cell: (c) => <span className="font-mono text-xs text-muted-foreground">{c.getValue()}</span>,
    }),
    col.accessor((r) => r.members, {
      id: "members",
      header: "Members",
      cell: (c) => <span className="block text-right tabular-nums">{formatCount(c.getValue())}</span>,
    }),
    col.accessor((r) => r.connections, {
      id: "connections",
      header: "Connections",
      cell: (c) => <span className="block text-right tabular-nums">{formatCount(c.getValue())}</span>,
    }),
    col.accessor((r) => r.openedAt, {
      id: "opened",
      header: "Opened",
      cell: (c) => <RelativeTime ms={c.getValue()} className="text-xs" />,
    }),
  ];

  return (
    <div className={SCREEN}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={BAR1}>
          <h1 className={BAR_TITLE}>Rooms</h1>
          {allowed && list.data && (
            <span className="text-sm text-muted-foreground tabular-nums" data-testid="rooms-summary">
              {roomsSummary(rooms)}
            </span>
          )}
        </div>
        {!allowed ? (
          <p className="p-4 text-sm text-muted-foreground md:p-6">
            This credential cannot view the deployment's rooms.
          </p>
        ) : noRooms ? (
          <p className="p-4 text-sm text-muted-foreground md:p-6">{NO_ROOMS}</p>
        ) : (
          <>
            <div className={BAR2}>
              <label htmlFor={filterId} className="text-sm text-muted-foreground">
                Definition
              </label>
              <ChoiceSelect
                id={filterId}
                size="sm"
                className="min-w-48"
                value={search.name ?? ALL}
                onValueChange={(v) => setSearch({ name: v === ALL ? undefined : v, room: undefined }, true)}
                options={[
                  { value: ALL, label: "Every definition" },
                  // a filter from a link keeps its name while no room of it is open
                  ...[...new Set([...names, ...(search.name ? [search.name] : [])])].map((n) => ({
                    value: n,
                    label: n,
                  })),
                ]}
              />
              <fieldset className="flex items-center gap-1 border-0 p-0 text-xs">
                <legend className="sr-only">Sort rooms by</legend>
                <span aria-hidden="true" className="text-muted-foreground">
                  Sort by
                </span>
                {(["name", "members"] as const).map((b) => (
                  <Button
                    key={b}
                    variant={by === b ? "secondary" : "ghost"}
                    size="xs"
                    aria-pressed={by === b}
                    onClick={() => setSearch({ sort: b === "members" ? "members" : undefined }, true)}
                  >
                    {b === "name" ? "Name" : "Members"}
                  </Button>
                ))}
              </fieldset>
            </div>
            {error && (
              <div className="px-4 pt-3 md:px-6">
                <ErrorState error={error} onRetry={() => void list.refetch()} />
              </div>
            )}
            {(list.data || !error) && (
              <DataTable
                label="Open rooms"
                fill
                columns={columns}
                data={shown}
                getRowId={(r) => r.key}
                defaultColumnWidth={(id) => ({ name: 200, args: 280, kind: 140 })[id] ?? 110}
                grid={{ activateOnClick: true, onCellActivate: (r) => setSearch({ room: r.key }) }}
                empty={
                  list.isPending
                    ? "Loading…"
                    : search.name
                      ? `No room of ${search.name} is open.`
                      : "No room or presence scope is open."
                }
              />
            )}
          </>
        )}
      </div>
      {opened && (
        <Panel
          kind="room"
          title={opened.state === "unknown" ? "Room" : opened.room.name}
          focusOnOpen={false}
          onClose={() => setSearch({ room: undefined })}
        >
          {opened.state === "unknown" ? (
            <p className="text-sm text-muted-foreground">This room is not open: it closed, or the link is old.</p>
          ) : (
            <RoomDetails room={opened.room} closed={opened.state === "closed"} />
          )}
        </Panel>
      )}
    </div>
  );
}

function RoomDetails({ room, closed }: { room: RoomInfo; closed: boolean }) {
  const scope = useQueryScope();
  const disconnected = useDisconnected();
  const members = useInfiniteQuery({
    queryKey: [...dashboardKeys.all(scope.scope), "rooms", "members", room.key] as const,
    queryFn: ({ signal, pageParam }) =>
      scope.source.listRoomMembers!({ key: room.key }, { numItems: MEMBERS_PAGE, cursor: pageParam }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.isDone ? undefined : last.continueCursor),
    // a closed room has no members to ask for: what was last shown stays
    enabled: !closed && !disconnected && typeof scope.source.listRoomMembers === "function",
    refetchInterval: closed ? false : ROOMS_POLL_MS,
  });
  const rows = members.data?.pages.flatMap((p) => p.page) ?? [];
  const scopeKind = room.kind === "presence";
  return (
    <div className="flex flex-col gap-4 text-sm">
      {closed && (
        <p role="status" className="border bg-muted/40 p-2">
          <Badge variant="outline" className="mr-2">
            Closed
          </Badge>
          Its last member left. This is what it showed last.
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">Kind</dt>
        <dd>{KIND_LABEL[room.kind]}</dd>
        <dt className="text-muted-foreground">Args</dt>
        <dd className="min-w-0">
          <LiteralView value={room.args} label="Args" />
        </dd>
        <dt className="text-muted-foreground">{scopeKind ? "Users" : "Members"}</dt>
        <dd className="tabular-nums">{formatCount(room.members)}</dd>
        <dt className="text-muted-foreground">Connections</dt>
        <dd className="tabular-nums">{formatCount(room.connections)}</dd>
        <dt className="text-muted-foreground">Opened</dt>
        <dd>
          <RelativeTime ms={room.openedAt} />{" "}
          <span className="text-muted-foreground">({formatTime(room.openedAt)})</span>
        </dd>
      </dl>
      <section aria-label="Members">
        <h3 className="mb-2 font-medium">{scopeKind ? "Users" : "Members"}</h3>
        {members.error ? (
          <ErrorState error={toDataSourceError(members.error)} onRetry={() => void members.refetch()} />
        ) : members.isPending && !closed ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">{closed ? "No member was listed." : "Nobody is in it now."}</p>
        ) : (
          <ul className={cn("flex flex-col gap-2", closed && "opacity-60")}>
            {rows.map((m) => (
              <MemberItem key={m.memberId} m={m} scopeKind={scopeKind} />
            ))}
          </ul>
        )}
        {members.hasNextPage && !closed && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={members.isFetchingNextPage}
            onClick={() => void members.fetchNextPage()}
          >
            {members.isFetchingNextPage ? "Loading…" : `Load ${MEMBERS_PAGE} more`}
          </Button>
        )}
      </section>
    </div>
  );
}

/** One member: who, the flags that explain what they can do, their presence (a scope's: state), and when. */
function MemberItem({ m, scopeKind }: { m: RoomMember; scopeKind: boolean }) {
  const what = scopeKind ? "State" : "Presence";
  const who = m.userId ?? "Signed out";
  return (
    <li className="border p-2" aria-label={scopeKind ? who : `${m.memberId}, ${who}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {!scopeKind && <span className="font-mono text-xs">{m.memberId}</span>}
        <span className={cn("text-xs", m.userId === null && "text-muted-foreground")}>{who}</span>
        {m.idle && <Badge variant="outline">Idle</Badge>}
        {!scopeKind && !m.canPublish && <Badge variant="outline">Cannot publish</Badge>}
        {m.graced && <Badge variant="outline">Reconnecting</Badge>}
      </div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
        <dt className="text-muted-foreground">{scopeKind ? "Tabs" : "Connections"}</dt>
        <dd className="tabular-nums">{formatCount(m.connections)}</dd>
        <dt className="text-muted-foreground">Joined</dt>
        <dd>
          <RelativeTime ms={m.joinedAt} />
        </dd>
        <dt className="text-muted-foreground">Last activity</dt>
        <dd>
          <RelativeTime ms={m.lastActivityAt} />
        </dd>
        <dt className="text-muted-foreground">{what}</dt>
        <dd className="min-w-0">
          {m.presence === null ? (
            <span className="text-muted-foreground">None set yet</span>
          ) : (
            <details>
              <summary className="cursor-pointer truncate font-mono">{shortValue(m.presence, 60)}</summary>
              <LiteralView value={m.presence} label={`${what} of ${scopeKind ? who : m.memberId}`} />
            </details>
          )}
        </dd>
      </dl>
    </li>
  );
}

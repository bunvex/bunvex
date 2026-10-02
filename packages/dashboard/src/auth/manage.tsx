// Authentication → Sessions and Organizations (UI-01 §25.2): every signed-in session (who, since when, until
// when, from where; Revoke), and the organizations with their members and pending invitations.
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useQueryScope } from "../context.tsx";
import { type AuthOrganization, type AuthSession, toDataSourceError } from "../data-source.ts";
import { formatTime } from "../database/values.ts";
import { DashLink } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";
import { BAR1 } from "../shell/bars.ts";
import { ConfirmButton } from "../shell/confirm.tsx";
import { ErrorState } from "../shell/error-state.tsx";
import { organizationsQuery, sessionsQuery, useRefreshAuth, usersQuery } from "./queries.ts";

/** A session's device, in a few words: "Safari on macOS". */
export function describeAgent(agent: string | null): string {
  if (!agent) return "Unknown device";
  if (agent.startsWith("bunvex")) return agent;
  const browser = /Chrome\//.test(agent)
    ? "Chrome"
    : /Safari\//.test(agent)
      ? "Safari"
      : /Firefox\//.test(agent)
        ? "Firefox"
        : "A browser";
  const os = /iPhone|iPad/.test(agent)
    ? "iOS"
    : /Mac OS X/.test(agent)
      ? "macOS"
      : /Windows/.test(agent)
        ? "Windows"
        : /Android/.test(agent)
          ? "Android"
          : /Linux/.test(agent)
            ? "Linux"
            : "an unknown system";
  return `${browser} on ${os}`;
}

const sessionCol = dataTableColumns<AuthSession>();

export function SessionsPage({ heading }: { heading: ReactNode }) {
  const scope = useQueryScope();
  const sessions = useQuery(sessionsQuery(scope));
  // the users' emails, from the loaded users (the first page holds most apps' users)
  const users = useInfiniteQuery(usersQuery(scope, {}));
  const emailOf = (id: string) => users.data?.pages.flatMap((p) => p.page).find((u) => u.id === id)?.email ?? id;
  const refresh = useRefreshAuth();
  const canRevoke = typeof scope.source.revokeAuthSession === "function";
  const rows = sessions.data ?? [];
  const columns: DataTableColumn<AuthSession>[] = [
    sessionCol.accessor((s) => s.userId, {
      id: "user",
      header: "User",
      cell: (c) => (
        <DashLink
          link={{ to: "/auth/$section", params: { section: "users" }, search: { user: c.getValue() } }}
          className="truncate text-sm text-primary underline-offset-2 hover:underline"
        >
          {emailOf(c.getValue())}
        </DashLink>
      ),
    }),
    sessionCol.accessor((s) => s.createdAt, {
      id: "created",
      header: "Signed in",
      cell: (c) => <span className="font-mono text-xs tabular-nums">{formatTime(c.getValue())}</span>,
    }),
    sessionCol.accessor((s) => s.expiresAt, {
      id: "expires",
      header: "Expires",
      cell: (c) => <span className="font-mono text-xs tabular-nums">{formatTime(c.getValue())}</span>,
    }),
    sessionCol.accessor((s) => describeAgent(s.userAgent), { id: "device", header: "Device" }),
    sessionCol.accessor((s) => s.ipAddress ?? "", {
      id: "ip",
      header: "IP address",
      cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span>,
    }),
    sessionCol.accessor((s) => s.impersonatedBy, {
      id: "impersonated",
      header: "Impersonated",
      cell: (c) => (c.getValue() ? <span className="text-xs text-warning">by {c.getValue()}</span> : null),
    }),
    sessionCol.display({
      id: "revoke",
      header: "",
      cell: (c) =>
        canRevoke && (
          <ConfirmButton
            label="Revoke"
            size="sm"
            variant="destructive-outline"
            title="Revoke this session?"
            description={`${emailOf(c.row.original.userId)} is signed out on ${describeAgent(c.row.original.userAgent)}.`}
            confirm="Revoke"
            busy="Revoking…"
            keep="Keep it"
            action={async () => {
              await scope.source.revokeAuthSession!(c.row.original.id);
              await refresh();
            }}
          />
        ),
    }),
  ];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={BAR1}>
        {heading}
        {sessions.data && (
          <span className="text-sm text-muted-foreground tabular-nums">
            {formatCount(rows.length)} active {rows.length === 1 ? "session" : "sessions"}
          </span>
        )}
      </div>
      {sessions.error ? (
        <ErrorState error={toDataSourceError(sessions.error)} />
      ) : (
        <DataTable
          label="Sessions"
          fill
          columns={columns}
          data={rows}
          getRowId={(s) => s.id}
          defaultColumnWidth={(id) =>
            ({ user: 260, created: 180, expires: 180, device: 160, ip: 130, impersonated: 130, revoke: 110 })[id] ?? 160
          }
          empty={sessions.isPending ? "Loading…" : "Nobody is signed in."}
        />
      )}
    </div>
  );
}

const orgCol = dataTableColumns<AuthOrganization>();

export function OrganizationsPage({ heading }: { heading: ReactNode }) {
  const scope = useQueryScope();
  const orgs = useQuery(organizationsQuery(scope));
  const columns: DataTableColumn<AuthOrganization>[] = [
    orgCol.accessor((o) => o.name, { id: "name", header: "Name" }),
    orgCol.accessor((o) => o.slug, {
      id: "slug",
      header: "Slug",
      cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span>,
    }),
    orgCol.accessor((o) => o.members, {
      id: "members",
      header: "Members",
      cell: (c) => <span className="tabular-nums">{formatCount(c.getValue())}</span>,
    }),
    orgCol.accessor((o) => o.invitations, {
      id: "invitations",
      header: "Pending invitations",
      cell: (c) => <span className="tabular-nums">{formatCount(c.getValue())}</span>,
    }),
    orgCol.accessor((o) => o.createdAt, {
      id: "created",
      header: "Created",
      cell: (c) => <span className="font-mono text-xs tabular-nums">{formatTime(c.getValue())}</span>,
    }),
  ];
  if (typeof scope.source.listAuthOrganizations !== "function")
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <div className={BAR1}>{heading}</div>
        <p className="p-4 text-sm text-muted-foreground md:p-6">
          This deployment does not offer organizations (better-auth's organization plugin).
        </p>
      </div>
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={BAR1}>
        {heading}
        {orgs.data && (
          <span className="text-sm text-muted-foreground tabular-nums">
            {formatCount(orgs.data.length)} {orgs.data.length === 1 ? "organization" : "organizations"}
          </span>
        )}
      </div>
      {orgs.error ? (
        <ErrorState error={toDataSourceError(orgs.error)} />
      ) : (
        <DataTable
          label="Organizations"
          fill
          columns={columns}
          data={orgs.data ?? []}
          getRowId={(o) => o.id}
          defaultColumnWidth={(id) =>
            ({ name: 220, slug: 160, members: 110, invitations: 170, created: 190 })[id] ?? 160
          }
          empty={orgs.isPending ? "Loading…" : "No organizations yet."}
        />
      )}
    </div>
  );
}

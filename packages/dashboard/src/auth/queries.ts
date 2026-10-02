// Reads for the Authentication screen (UI-01 §25), in the dashboard's query cache; a write refreshes them all.
import { infiniteQueryOptions, queryOptions, useQueryClient } from "@tanstack/react-query";
import { useQueryScope } from "../context.tsx";
import { dashboardKeys, type QueryScope } from "../data/queries.ts";
import type { AuthUserQuery } from "../data-source.ts";

export const USERS_PAGE = 50;
type UserFilter = Omit<AuthUserQuery, "numItems" | "cursor">;

export const authKeys = {
  all: (scope: string) => [...dashboardKeys.all(scope), "auth"] as const,
};

export const usersQuery = ({ source, scope }: QueryScope, f: UserFilter) =>
  infiniteQueryOptions({
    queryKey: [...authKeys.all(scope), "users", f.search ?? "", f.provider ?? null, f.status ?? null] as const,
    queryFn: ({ pageParam, signal }) =>
      source.listAuthUsers!({ ...f, numItems: USERS_PAGE, cursor: pageParam }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.isDone ? undefined : last.continueCursor),
  });

export const userQuery = ({ source, scope }: QueryScope, id: string) =>
  queryOptions({
    queryKey: [...authKeys.all(scope), "user", id] as const,
    queryFn: ({ signal }) => source.getAuthUser!(id, { signal }),
    enabled: typeof source.getAuthUser === "function",
  });

export const sessionsQuery = ({ source, scope }: QueryScope, userId?: string) =>
  queryOptions({
    queryKey: [...authKeys.all(scope), "sessions", userId ?? null] as const,
    queryFn: ({ signal }) => source.listAuthSessions!({ userId }, { signal }),
    enabled: typeof source.listAuthSessions === "function",
  });

export const organizationsQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: [...authKeys.all(scope), "organizations"] as const,
    queryFn: ({ signal }) => source.listAuthOrganizations!({ signal }),
    enabled: typeof source.listAuthOrganizations === "function",
  });

export const membersQuery = ({ source, scope }: QueryScope, organizationId: string) =>
  queryOptions({
    queryKey: [...authKeys.all(scope), "members", organizationId] as const,
    queryFn: ({ signal }) => source.listAuthMembers!(organizationId, { signal }),
    enabled: typeof source.listAuthMembers === "function",
  });

export const invitationsQuery = ({ source, scope }: QueryScope, organizationId: string) =>
  queryOptions({
    queryKey: [...authKeys.all(scope), "invitations", organizationId] as const,
    queryFn: ({ signal }) => source.listAuthInvitations!(organizationId, { signal }),
    enabled: typeof source.listAuthInvitations === "function",
  });

export const configQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: [...authKeys.all(scope), "config"] as const,
    queryFn: ({ signal }) => source.getAuthConfig!({ signal }),
    enabled: typeof source.getAuthConfig === "function",
  });

export const eventsQuery = ({ source, scope }: QueryScope, userId?: string) =>
  queryOptions({
    queryKey: [...authKeys.all(scope), "events", userId ?? null] as const,
    queryFn: ({ signal }) => source.listAuthEvents!({ userId, limit: 200 }, { signal }),
    enabled: typeof source.listAuthEvents === "function",
  });

/** After a write: every auth read again. */
export function useRefreshAuth() {
  const queryClient = useQueryClient();
  const { scope } = useQueryScope();
  return () => queryClient.invalidateQueries({ queryKey: authKeys.all(scope) });
}

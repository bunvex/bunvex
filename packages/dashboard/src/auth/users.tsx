// Authentication → Users (UI-01 §25.1): the app's users in a full-bleed grid — avatar, name, email,
// providers, created, last sign-in, status — searched by name or email and filtered by provider and status
// (Bar 2, and the column's filters; the source filters, `listAuthUsers`); "Add user" (create one, or invite by email: a split button);
// a user's panel, docked while one is selected and following the current row.
import { Button } from "@bunvex/ui/components/button";
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bunvex/ui/components/dropdown-menu";
import { Input } from "@bunvex/ui/components/input";
import { cn } from "@bunvex/ui/lib/utils";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown, Mail, UserPlus } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery } from "../data/queries.ts";
import { type AuthUser, type AuthUserStatus, toDataSourceError, userStatus } from "../data-source.ts";
import { formatTime } from "../database/values.ts";
import { type AuthSearch, authRoute } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";
import { BAR1, BAR2 } from "../shell/bars.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { Panel } from "../shell/panel.tsx";
import { FacetRadios, SectionFilters } from "../shell/section-column.tsx";
import { PROVIDER_LABEL } from "./config.tsx";
import { useRefreshAuth, usersQuery } from "./queries.ts";
import { UserPanel } from "./user-panel.tsx";

const col = dataTableColumns<AuthUser>();

export function Avatar({ user, className }: { user: AuthUser; className?: string }) {
  const initials = user.name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground",
        className,
      )}
    >
      {initials}
    </span>
  );
}

export function UserStatusBadge({ user }: { user: AuthUser }) {
  const s = userStatus(user);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 border px-1.5 text-xs",
        s === "banned"
          ? "border-destructive/40 text-destructive"
          : s === "verified"
            ? "text-foreground"
            : "text-muted-foreground",
      )}
    >
      {s === "banned" ? "Banned" : s === "verified" ? "Verified" : "Unverified"}
    </span>
  );
}

export const providerLabel = (p: string) => PROVIDER_LABEL[p] ?? p;

const STATUSES: { value: AuthUserStatus | "all"; label: string }[] = [
  { value: "all", label: "Any status" },
  { value: "verified", label: "Verified" },
  { value: "unverified", label: "Unverified" },
  { value: "banned", label: "Banned" },
];

/** The Users page's filters, under the column's nav: provider and status, with the loaded users' counts. */
export function UserFilters() {
  const scope = useQueryScope();
  const search = authRoute.useSearch();
  const navigate = authRoute.useNavigate();
  const set = (patch: Partial<AuthSearch>) =>
    navigate({ search: (s: AuthSearch): AuthSearch => ({ ...s, ...patch, user: undefined }) });
  // counted over the loaded users that match the search (every provider and status)
  const all = useInfiniteQuery(usersQuery(scope, { search: search.q }));
  const loaded = all.data?.pages.flatMap((p) => p.page) ?? [];
  const byProvider = new Map<string, number>();
  const byStatus = new Map<string, number>();
  for (const u of loaded) {
    for (const p of u.providers) byProvider.set(p, (byProvider.get(p) ?? 0) + 1);
    byStatus.set(userStatus(u), (byStatus.get(userStatus(u)) ?? 0) + 1);
  }
  const filtered = search.provider !== undefined || search.status !== undefined;
  return (
    <SectionFilters
      label="User filters"
      onReset={filtered ? () => set({ provider: undefined, status: undefined }) : undefined}
    >
      <FacetRadios
        title="Provider"
        value={search.provider ?? "all"}
        onChange={(v) => set({ provider: v === "all" ? undefined : v })}
        options={[
          { value: "all", label: "Any provider", count: loaded.length },
          ...Object.keys(PROVIDER_LABEL).map((p) => ({
            value: p,
            label: providerLabel(p),
            count: byProvider.get(p) ?? 0,
          })),
        ]}
      />
      <FacetRadios
        title="Status"
        value={search.status ?? "all"}
        onChange={(v) => set({ status: v === "all" ? undefined : (v as AuthUserStatus) })}
        options={STATUSES.map((s) => ({
          ...s,
          count: s.value === "all" ? loaded.length : (byStatus.get(s.value) ?? 0),
        }))}
      />
      {all.hasNextPage && <p className="px-3 pt-1 text-xs text-muted-foreground">Counts are of the loaded users.</p>}
    </SectionFilters>
  );
}

function AddUser(props: { onPick: (how: "create" | "invite") => void; disabled: boolean }) {
  return (
    <span className="inline-flex">
      <Button size="sm" variant="outline" disabled={props.disabled} onClick={() => props.onPick("create")}>
        <UserPlus aria-hidden="true" />
        Add user
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="sm"
              variant="outline"
              disabled={props.disabled}
              className="-ml-px px-1.5"
              aria-label="More ways to add a user"
            />
          }
        >
          <ChevronDown aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-44">
          <DropdownMenuItem onClick={() => props.onPick("create")}>
            <UserPlus aria-hidden="true" />
            Create user
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => props.onPick("invite")}>
            <Mail aria-hidden="true" />
            Invite by email
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/** Create a user, or invite one: a form in the docked panel. */
function AddUserPanel(props: { how: "create" | "invite"; onDone: (id?: string) => void; onClose: () => void }) {
  const { source } = useQueryScope();
  const refresh = useRefreshAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const ids = { name: useId(), email: useId(), password: useId() };
  const create = props.how === "create";
  return (
    <Panel kind="auth-add" title={create ? "Create user" : "Invite by email"} onClose={props.onClose}>
      <form
        className="flex flex-col gap-3 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setProblem(undefined);
          try {
            if (create) {
              const id = await source.createAuthUser!({ name, email, password: password || undefined });
              await refresh();
              props.onDone(id);
            } else {
              await source.inviteAuthUser!(email);
              await refresh();
              props.onDone();
            }
          } catch (err) {
            setProblem(toDataSourceError(err).message);
          }
          setBusy(false);
        }}
      >
        {create && (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.name}>Name</label>
            <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.email}>Email</label>
          <Input id={ids.email} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {create && (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.password}>Password (optional)</label>
            <Input
              id={ids.password}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Without one, the user signs in another way (a magic link, a provider).
            </p>
          </div>
        )}
        {!create && <p className="text-xs text-muted-foreground">They get an email with a link to sign up.</p>}
        {problem && (
          <p role="alert" className="text-destructive">
            {problem}
          </p>
        )}
        <div>
          <Button type="submit" size="sm" disabled={busy || email.trim() === ""}>
            {busy ? (create ? "Creating…" : "Sending…") : create ? "Create user" : "Send invitation"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

export function UsersPage({ heading }: { heading: ReactNode }) {
  const scope = useQueryScope();
  const { source } = scope;
  const search = authRoute.useSearch();
  const navigate = authRoute.useNavigate();
  const setSearch = (patch: Partial<AuthSearch>, replace = false) =>
    navigate({ search: (s: AuthSearch): AuthSearch => ({ ...s, ...patch }), replace });
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const canWrite = caps !== undefined && !caps.readOnly && caps.operations.includes("writeData");
  const list = useInfiniteQuery(
    usersQuery(scope, { search: search.q, provider: search.provider, status: search.status }),
  );
  const users = list.data?.pages.flatMap((p) => p.page) ?? [];
  const [adding, setAdding] = useState<"create" | "invite">();
  const [notice, setNotice] = useState<string>();
  // the search applies 200 ms after the last keystroke
  const [text, setText] = useState(search.q ?? "");
  useEffect(() => setText(search.q ?? ""), [search.q]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the typed text starts the wait
  useEffect(() => {
    if (text === (search.q ?? "")) return;
    const t = setTimeout(() => setSearch({ q: text || undefined, user: undefined }, true), 200);
    return () => clearTimeout(t);
  }, [text]);

  const columns: DataTableColumn<AuthUser>[] = [
    col.accessor((u) => u.name, {
      id: "name",
      header: "Name",
      cell: (c) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar user={c.row.original} />
          <span className="truncate">{c.getValue()}</span>
        </span>
      ),
    }),
    col.accessor((u) => u.email, {
      id: "email",
      header: "Email",
      cell: (c) => <span className="truncate font-mono text-xs">{c.getValue()}</span>,
    }),
    col.accessor((u) => u.providers.map(providerLabel).join(", "), {
      id: "providers",
      header: "Providers",
      cell: (c) => <span className="truncate text-xs">{c.getValue() || "None"}</span>,
    }),
    col.accessor((u) => u.createdAt, {
      id: "created",
      header: "Created",
      cell: (c) => <span className="font-mono text-xs tabular-nums">{formatTime(c.getValue())}</span>,
    }),
    col.accessor((u) => u.lastSignInAt, {
      id: "last",
      header: "Last sign-in",
      cell: (c) => (
        <span className="font-mono text-xs tabular-nums">
          {c.getValue() === null ? <span className="text-muted-foreground">Never</span> : formatTime(c.getValue()!)}
        </span>
      ),
    }),
    col.accessor((u) => userStatus(u), {
      id: "status",
      header: "Status",
      cell: (c) => <UserStatusBadge user={c.row.original} />,
    }),
  ];

  const filtered = search.q !== undefined || search.provider !== undefined || search.status !== undefined;
  return (
    <>
      <div className="@container/users flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={BAR1}>
          {heading}
          {!list.isPending && (
            <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
              {`${formatCount(users.length)}${list.hasNextPage ? "+" : ""} ${users.length === 1 && !list.hasNextPage ? "user" : "users"}`}
            </span>
          )}
          <span className="ml-auto">
            {(typeof source.createAuthUser === "function" || typeof source.inviteAuthUser === "function") && (
              <AddUser disabled={!canWrite} onPick={(how) => setAdding(how)} />
            )}
          </span>
        </div>
        <div className={BAR2}>
          <Input
            type="search"
            aria-label="Search users"
            placeholder="Search by name or email…"
            className="h-8 w-64"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <p role="status" className="border-b px-4 py-1.5 text-sm text-muted-foreground empty:hidden md:px-6">
          {notice}
        </p>
        {list.error ? (
          <ErrorState error={toDataSourceError(list.error)} />
        ) : (
          <DataTable
            label="Users"
            fill
            columns={columns}
            data={users}
            getRowId={(u) => u.id}
            defaultColumnWidth={(id) =>
              ({ name: 220, email: 280, providers: 200, created: 180, last: 180, status: 110 })[id] ?? 160
            }
            onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && void list.fetchNextPage()}
            grid={{
              activateOnClick: true,
              onCellActivate: (u) => {
                setAdding(undefined);
                setSearch({ user: u.id, tab: undefined });
              },
              // the open user follows the current row, as on Database and Logs
              onCellFocus: (u) => search.user !== undefined && u.id !== search.user && setSearch({ user: u.id }, true),
            }}
            empty={list.isPending ? "Loading…" : filtered ? "No user matches these filters." : "No users yet."}
            footer={list.hasNextPage ? <span>{`${users.length} loaded`}</span> : undefined}
          />
        )}
      </div>
      {adding ? (
        <AddUserPanel
          how={adding}
          onClose={() => setAdding(undefined)}
          onDone={(id) => {
            setNotice(adding === "create" ? "Created the user." : "Sent the invitation.");
            setAdding(undefined);
            if (id) setSearch({ user: id, tab: undefined });
          }}
        />
      ) : (
        search.user !== undefined && (
          <UserPanel
            id={search.user}
            tab={search.tab ?? "overview"}
            onTab={(tab) => setSearch({ tab: tab === "overview" ? undefined : tab }, true)}
            onRemoved={() => {
              setNotice("Deleted the user.");
              setSearch({ user: undefined, tab: undefined }, true);
            }}
            onClose={() => setSearch({ user: undefined, tab: undefined })}
          />
        )
      )}
    </>
  );
}

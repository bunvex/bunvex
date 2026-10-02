// A user's panel (UI-01 §25.1), docked while the user is selected: tabs Overview, Logs, Raw JSON. Overview:
// who they are, their providers, emails to send them (password reset, magic link, email verification), their
// sessions (each revocable), and a Danger zone — revoke every session, remove their second factors, ban
// (for a while, or for good) or unban, impersonate, delete — each asking first.

import { Button } from "@bunvex/ui/components/button";
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { Input } from "@bunvex/ui/components/input";
import { JsonView } from "@bunvex/ui/components/json-view";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@bunvex/ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@bunvex/ui/components/tabs";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery } from "../data/queries.ts";
import { type AuthEmailAction, type AuthUser, toDataSourceError } from "../data-source.ts";
import { formatTime } from "../database/values.ts";
import { ConfirmButton } from "../shell/confirm.tsx";
import { ErrorState } from "../shell/error-state.tsx";
import { Panel } from "../shell/panel.tsx";
import { AuthEventsTable } from "./config.tsx";
import { describeAgent } from "./manage.tsx";
import { eventsQuery, sessionsQuery, useRefreshAuth, userQuery } from "./queries.ts";
import { Avatar, providerLabel, UserStatusBadge } from "./users.tsx";

const BAN_FOR = [
  { label: "1 hour", seconds: 3_600 },
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
  { label: "For good", seconds: 0 },
] as const;

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

export function UserPanel(props: {
  id: string;
  tab: "overview" | "logs" | "json";
  onTab: (tab: "overview" | "logs" | "json") => void;
  onRemoved: () => void;
  onClose: () => void;
}) {
  const scope = useQueryScope();
  const user = useQuery(userQuery(scope, props.id));
  const u = user.data;
  return (
    <Panel kind="auth-user" focusOnOpen={false} title={u ? u.name : "User"} onClose={props.onClose}>
      {user.error ? (
        <ErrorState error={toDataSourceError(user.error)} />
      ) : user.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !u ? (
        <p className="text-sm text-muted-foreground">There is no such user: deleted, or the ID is wrong.</p>
      ) : (
        <Tabs value={props.tab} onValueChange={(t) => props.onTab(t as typeof props.tab)} className="gap-4">
          <TabsList aria-label={`${u.name}: overview, logs or raw JSON`}>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="json">Raw JSON</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <Overview user={u} onRemoved={props.onRemoved} />
          </TabsContent>
          <TabsContent value="logs">
            <UserLogs id={u.id} />
          </TabsContent>
          <TabsContent value="json">
            <JsonView value={u} label="This user as JSON" className="text-xs [&_pre]:p-3 [&_pre]:text-xs" />
          </TabsContent>
        </Tabs>
      )}
    </Panel>
  );
}

function UserLogs({ id }: { id: string }) {
  const scope = useQueryScope();
  const events = useQuery(eventsQuery(scope, id));
  if (events.error) return <ErrorState error={toDataSourceError(events.error)} />;
  return <AuthEventsTable label="This user's auth events" events={events.data} pending={events.isPending} />;
}

function Overview({ user: u, onRemoved }: { user: AuthUser; onRemoved: () => void }) {
  const scope = useQueryScope();
  const { source } = scope;
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const canWrite = caps !== undefined && !caps.readOnly && caps.operations.includes("writeData");
  const sessions = useQuery(sessionsQuery(scope, u.id));
  const refresh = useRefreshAuth();
  const [said, setSaid] = useState<{ ok: boolean; message: string }>();
  const [banFor, setBanFor] = useState<number>(86_400);
  const [reason, setReason] = useState("");
  const banForId = useId();
  const reasonId = useId();
  const act = async (message: string, run: () => Promise<unknown>) => {
    try {
      await run();
      setSaid({ ok: true, message });
      await refresh();
    } catch (err) {
      setSaid({ ok: false, message: toDataSourceError(err).message });
    }
  };
  const send = (kind: AuthEmailAction, done: string) => act(done, () => source.sendAuthEmail!(u.id, kind));

  return (
    <div className="flex flex-col gap-5 text-sm">
      <div className="flex items-center gap-3">
        <Avatar user={u} className="size-10 text-sm" />
        <div className="min-w-0">
          <p className="truncate font-medium">{u.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{u.email}</p>
        </div>
        <span className="ml-auto">
          <UserStatusBadge user={u} />
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <Row term="User ID">
          <span className="flex items-center gap-1">
            <code className="truncate font-mono text-xs">{u.id}</code>
            <CopyButton text={u.id} label="Copy user ID" iconOnly />
          </span>
        </Row>
        <Row term="Email">{u.emailVerified ? "Verified" : "Not verified"}</Row>
        <Row term="Role">{u.role}</Row>
        <Row term="Created">{formatTime(u.createdAt)}</Row>
        <Row term="Last sign-in">{u.lastSignInAt === null ? "Never" : formatTime(u.lastSignInAt)}</Row>
        <Row term="Two-factor">{u.twoFactorEnabled ? "On" : "Off"}</Row>
        <Row term="Passkeys">{u.passkeys}</Row>
        {u.banned && (
          <Row term="Banned">
            {u.banReason ?? "No reason given"} ·{" "}
            {u.banExpires === null ? "for good" : `until ${formatTime(u.banExpires)}`}
          </Row>
        )}
      </dl>

      <section aria-label="Providers">
        <h3 className="mb-1 font-medium">Providers</h3>
        {u.providers.length === 0 ? (
          <p className="text-muted-foreground">No way to sign in yet.</p>
        ) : (
          <ul className="flex flex-col border">
            {u.providers.map((p) => (
              <li key={p} className="border-b px-2 py-1 last:border-b-0">
                {providerLabel(p)}
              </li>
            ))}
          </ul>
        )}
      </section>

      {typeof source.sendAuthEmail === "function" && (
        <section aria-label="Emails">
          <h3 className="mb-1 font-medium">Send an email</h3>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite}
              onClick={() => send("password-reset", "Sent a password reset.")}
            >
              Password reset
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite}
              onClick={() => send("magic-link", "Sent a magic link.")}
            >
              Magic link
            </Button>
            {!u.emailVerified && (
              <Button
                size="sm"
                variant="outline"
                disabled={!canWrite}
                onClick={() => send("verify-email", "Sent a verification email.")}
              >
                Verify email
              </Button>
            )}
          </div>
        </section>
      )}

      <p
        role={said && !said.ok ? "alert" : "status"}
        className={said?.ok === false ? "text-destructive empty:hidden" : "text-muted-foreground empty:hidden"}
      >
        {said?.message}
      </p>

      <section aria-label="Sessions">
        <h3 className="mb-1 font-medium">Sessions</h3>
        {!sessions.data ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : sessions.data.length === 0 ? (
          <p className="text-muted-foreground">Not signed in anywhere.</p>
        ) : (
          <ul className="flex flex-col border">
            {sessions.data.map((s) => (
              <li key={s.id} className="flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {describeAgent(s.userAgent)}
                    {s.impersonatedBy && <span className="text-warning"> · impersonated by {s.impersonatedBy}</span>}
                  </span>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {s.ipAddress ?? "no IP"} · since {formatTime(s.createdAt)}
                  </span>
                </span>
                {typeof source.revokeAuthSession === "function" && (
                  <ConfirmButton
                    label="Revoke"
                    size="sm"
                    variant="destructive-outline"
                    disabled={!canWrite}
                    title="Revoke this session?"
                    description={`${u.email} is signed out on ${describeAgent(s.userAgent)}.`}
                    confirm="Revoke"
                    busy="Revoking…"
                    keep="Keep it"
                    action={() => act("Revoked the session.", () => source.revokeAuthSession!(s.id))}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Danger zone" className="border border-destructive/40 p-3">
        <h3 className="mb-3 font-medium text-destructive">Danger zone</h3>
        <div className="flex flex-col gap-3">
          {typeof source.revokeAuthUserSessions === "function" && (
            <ConfirmButton
              label="Revoke all sessions"
              variant="destructive-outline"
              size="sm"
              disabled={!canWrite || !sessions.data?.length}
              title={`Sign ${u.name} out everywhere?`}
              description="Every session ends; they sign in again to continue."
              confirm="Revoke all"
              busy="Revoking…"
              keep="Keep them"
              action={() => act("Revoked every session.", () => source.revokeAuthUserSessions!(u.id))}
            />
          )}
          {typeof source.removeAuthUserFactors === "function" && (
            <ConfirmButton
              label="Remove MFA factors"
              variant="destructive-outline"
              size="sm"
              disabled={!canWrite || (!u.twoFactorEnabled && u.passkeys === 0)}
              title="Remove their second factors?"
              description="Two-factor turns off and their passkeys are removed; they set them up again."
              confirm="Remove factors"
              busy="Removing…"
              keep="Keep them"
              action={() => act("Removed the second factors.", () => source.removeAuthUserFactors!(u.id))}
            />
          )}
          {u.banned
            ? typeof source.unbanAuthUser === "function" && (
                <ConfirmButton
                  label="Unban"
                  variant="outline"
                  size="sm"
                  confirmVariant="default"
                  disabled={!canWrite}
                  title={`Unban ${u.name}?`}
                  description="They can sign in again."
                  confirm="Unban"
                  busy="Unbanning…"
                  keep="Keep the ban"
                  action={() => act("Unbanned.", () => source.unbanAuthUser!(u.id))}
                />
              )
            : typeof source.banAuthUser === "function" && (
                <div className="flex flex-wrap items-end gap-2">
                  <span className="flex flex-col gap-1">
                    <label htmlFor={banForId} className="text-xs text-muted-foreground">
                      Ban for
                    </label>
                    <Select
                      items={BAN_FOR.map((b) => ({ value: String(b.seconds), label: b.label }))}
                      value={String(banFor)}
                      onValueChange={(v) => setBanFor(Number(v))}
                    >
                      <SelectTrigger id={banForId} className="min-w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BAN_FOR.map((b) => (
                          <SelectItem key={b.label} value={String(b.seconds)}>
                            {b.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </span>
                  <span className="flex flex-col gap-1">
                    <label htmlFor={reasonId} className="text-xs text-muted-foreground">
                      Reason
                    </label>
                    <Input
                      id={reasonId}
                      className="h-8 w-40"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </span>
                  <ConfirmButton
                    label="Ban user"
                    variant="destructive"
                    size="sm"
                    disabled={!canWrite}
                    title={`Ban ${u.name}?`}
                    description={`They are signed out and cannot sign in ${banFor === 0 ? "until unbanned" : `for ${BAN_FOR.find((b) => b.seconds === banFor)?.label}`}.`}
                    confirm="Ban"
                    busy="Banning…"
                    keep="Don't ban"
                    action={() =>
                      act("Banned.", () =>
                        source.banAuthUser!(u.id, {
                          reason: reason || undefined,
                          expiresInSeconds: banFor || undefined,
                        }),
                      )
                    }
                  />
                </div>
              )}
          {typeof source.impersonateAuthUser === "function" && (
            <ConfirmButton
              label="Impersonate"
              variant="destructive-outline"
              size="sm"
              disabled={!canWrite || u.banned}
              title={`Impersonate ${u.name}?`}
              description="A one-hour session acting as them starts; it is recorded in the audit log."
              confirm="Impersonate"
              busy="Starting…"
              keep="Cancel"
              action={() => act("Started a session as this user.", () => source.impersonateAuthUser!(u.id))}
            />
          )}
          {typeof source.removeAuthUser === "function" && (
            <ConfirmButton
              label="Delete user"
              variant="destructive"
              size="sm"
              disabled={!canWrite}
              title={`Delete ${u.name}?`}
              description="Their account, providers and sessions are removed. This cannot be undone."
              confirm="Delete user"
              busy="Deleting…"
              keep="Keep them"
              action={async () => {
                await source.removeAuthUser!(u.id);
                await refresh();
                onRemoved();
              }}
            />
          )}
        </div>
      </section>
    </div>
  );
}

// An organization's panel (UI-01 §25.2), docked while one is selected: tabs Members and Invitations, in
// better-auth's organization plugin's terms. Members: name, email, role (changeable), since; Remove asks
// first, and an organization keeps an owner (the source refuses otherwise and the reason is shown).
// Invitations: every status, newest first; Resend and Cancel for the pending ones; Invite by email with a role.
import { Button } from "@bunvex/ui/components/button";
import { Input } from "@bunvex/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@bunvex/ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@bunvex/ui/components/tabs";
import { useQuery } from "@tanstack/react-query";
import { Ban, CircleCheck, CircleDashed, CircleX } from "lucide-react";
import { useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery } from "../data/queries.ts";
import {
  AUTH_MEMBER_ROLES,
  type AuthInvitation,
  type AuthMember,
  type AuthMemberRole,
  type AuthOrganization,
  toDataSourceError,
} from "../data-source.ts";
import { formatTime } from "../database/values.ts";
import { ConfirmButton } from "../shell/confirm.tsx";
import { ErrorState } from "../shell/error-state.tsx";
import { Panel } from "../shell/panel.tsx";
import { invitationsQuery, membersQuery, useRefreshAuth } from "./queries.ts";

export type OrgTab = "members" | "invitations";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };
export const roleLabel = (role: AuthMemberRole) => ROLE_LABEL[role] ?? role;

function RolePicker(props: {
  label: string;
  value: AuthMemberRole;
  disabled?: boolean;
  onChange: (role: AuthMemberRole) => void;
}) {
  return (
    <Select
      items={AUTH_MEMBER_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
      value={props.value}
      disabled={props.disabled}
      onValueChange={(v) => v && props.onChange(v as AuthMemberRole)}
    >
      <SelectTrigger aria-label={props.label} size="sm" className="w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {AUTH_MEMBER_ROLES.map((r) => (
          <SelectItem key={r} value={r}>
            {roleLabel(r)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Members({ org, canWrite }: { org: AuthOrganization; canWrite: boolean }) {
  const scope = useQueryScope();
  const members = useQuery(membersQuery(scope, org.id));
  const refresh = useRefreshAuth();
  const [error, setError] = useState<string>();
  const canRole = canWrite && typeof scope.source.updateAuthMemberRole === "function";
  const canRemove = canWrite && typeof scope.source.removeAuthMember === "function";
  if (members.error) return <ErrorState error={toDataSourceError(members.error)} />;
  if (members.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const rows = members.data ?? [];
  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No members.</p>
      ) : (
        <ul aria-label={`Members of ${org.name}`} className="divide-y border-y">
          {rows.map((m: AuthMember) => (
            <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{m.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{m.email}</span>
              </span>
              {canRole ? (
                <RolePicker
                  label={`Role of ${m.name}`}
                  value={m.role}
                  onChange={async (role) => {
                    setError(undefined);
                    try {
                      await scope.source.updateAuthMemberRole!(m.id, role);
                    } catch (e) {
                      setError(toDataSourceError(e).message);
                    }
                    await refresh();
                  }}
                />
              ) : (
                <span className="text-xs text-muted-foreground">{roleLabel(m.role)}</span>
              )}
              {canRemove && (
                <ConfirmButton
                  label="Remove"
                  size="sm"
                  variant="destructive-outline"
                  title={`Remove ${m.name} from ${org.name}?`}
                  description="They lose access to the organization. Their user account stays."
                  confirm="Remove member"
                  busy="Removing…"
                  keep="Keep them"
                  action={async () => {
                    await scope.source.removeAuthMember!(m.id);
                    await refresh();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// an invitation's status: an icon and the word, never the colour alone
const INVITATION_LOOK = {
  pending: { icon: CircleDashed, label: "Pending", tone: "text-warning" },
  accepted: { icon: CircleCheck, label: "Accepted", tone: "text-success" },
  rejected: { icon: CircleX, label: "Rejected", tone: "text-muted-foreground" },
  canceled: { icon: Ban, label: "Canceled", tone: "text-muted-foreground" },
} as const;

function InvitationStatus({ status }: { status: AuthInvitation["status"] }) {
  const { icon: Icon, label, tone } = INVITATION_LOOK[status];
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <Icon aria-hidden="true" className={`size-3.5 ${tone}`} />
      {label}
    </span>
  );
}

function InviteForm({ org, onSent }: { org: AuthOrganization; onSent: (email: string) => void }) {
  const scope = useQueryScope();
  const refresh = useRefreshAuth();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AuthMemberRole>("member");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const emailId = useId();
  const errorId = useId();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(undefined);
        try {
          await scope.source.inviteAuthMember!(org.id, { email, role });
          onSent(email.trim());
          setEmail("");
          await refresh();
        } catch (err) {
          setError(toDataSourceError(err).message);
        }
        setBusy(false);
      }}
    >
      <label htmlFor={emailId} className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
        Invite by email
        <Input
          id={emailId}
          type="email"
          required
          placeholder="name@example.com"
          className="h-8"
          value={email}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <RolePicker label="Role of the invited member" value={role} onChange={setRole} />
      <Button type="submit" size="sm" disabled={busy || !email.trim()}>
        {busy ? "Inviting…" : "Invite"}
      </Button>
      {error && (
        <p id={errorId} role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

function Invitations({ org, canWrite }: { org: AuthOrganization; canWrite: boolean }) {
  const scope = useQueryScope();
  const invitations = useQuery(invitationsQuery(scope, org.id));
  const refresh = useRefreshAuth();
  const [notice, setNotice] = useState<string>();
  const canInvite = canWrite && typeof scope.source.inviteAuthMember === "function";
  const canResend = canWrite && typeof scope.source.resendAuthInvitation === "function";
  const canCancel = canWrite && typeof scope.source.cancelAuthInvitation === "function";
  if (invitations.error) return <ErrorState error={toDataSourceError(invitations.error)} />;
  if (invitations.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const rows = invitations.data ?? [];
  return (
    <div className="flex flex-col gap-3">
      {canInvite && <InviteForm org={org} onSent={(email) => setNotice(`Invited ${email}.`)} />}
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {notice}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No invitations.</p>
      ) : (
        <ul aria-label={`Invitations to ${org.name}`} className="divide-y border-y">
          {rows.map((i: AuthInvitation) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-xs">{i.email}</span>
                <span className="text-xs text-muted-foreground">
                  {roleLabel(i.role)} · sent {formatTime(i.createdAt)}
                  {i.status === "pending" && ` · expires ${formatTime(i.expiresAt)}`}
                </span>
              </span>
              <InvitationStatus status={i.status} />
              {i.status === "pending" && canResend && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await scope.source.resendAuthInvitation!(i.id);
                    setNotice(`Sent the invitation to ${i.email} again.`);
                    await refresh();
                  }}
                >
                  Resend
                </Button>
              )}
              {i.status === "pending" && canCancel && (
                <ConfirmButton
                  label="Cancel"
                  size="sm"
                  variant="destructive-outline"
                  title={`Cancel the invitation to ${i.email}?`}
                  description="The link in the email stops working."
                  confirm="Cancel invitation"
                  busy="Canceling…"
                  keep="Keep it"
                  action={async () => {
                    await scope.source.cancelAuthInvitation!(i.id);
                    await refresh();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function OrgPanel(props: {
  org: AuthOrganization | undefined;
  tab: OrgTab;
  onTab: (tab: OrgTab) => void;
  onClose: () => void;
}) {
  const scope = useQueryScope();
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const canWrite = caps !== undefined && !caps.readOnly && caps.operations.includes("writeData");
  const { org } = props;
  return (
    <Panel kind="auth-org" focusOnOpen={false} title={org?.name ?? "Organization"} onClose={props.onClose}>
      {!org ? (
        <p className="text-sm text-muted-foreground">There is no such organization.</p>
      ) : (
        <Tabs value={props.tab} onValueChange={(t) => props.onTab(t as OrgTab)} className="gap-4">
          <p className="font-mono text-xs text-muted-foreground">{org.slug}</p>
          <TabsList>
            <TabsTrigger value="members">Members ({org.members})</TabsTrigger>
            <TabsTrigger value="invitations">Invitations ({org.invitations})</TabsTrigger>
          </TabsList>
          <TabsContent value="members">
            <Members org={org} canWrite={canWrite} />
          </TabsContent>
          <TabsContent value="invitations">
            <Invitations org={org} canWrite={canWrite} />
          </TabsContent>
        </Tabs>
      )}
    </Panel>
  );
}

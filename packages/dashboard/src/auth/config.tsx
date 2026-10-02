// Authentication → Configuration (UI-01 §25.3): one page per part of the auth configuration — sign-in methods
// (and the token providers that were Settings → Authentication), multi-factor, passkeys, session lifetime, rate
// limits, URLs, email templates — each a form that saves its part (`updateAuthConfig`); and the audit log.

import { Button } from "@bunvex/ui/components/button";
import { Checkbox } from "@bunvex/ui/components/checkbox";
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { Input } from "@bunvex/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@bunvex/ui/components/select";
import { Textarea } from "@bunvex/ui/components/textarea";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery } from "../data/queries.ts";
import { type AuthConfig, type AuthEmailKind, type AuthEvent, toDataSourceError } from "../data-source.ts";
import { formatTime } from "../database/values.ts";
import type { AuthSection } from "../router.tsx";
import { TokenProviders } from "../settings/auth.tsx";
import { BAR1 } from "../shell/bars.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { EMAIL_VARIABLES, renderEmail, unknownVariables } from "./email-preview.ts";
import { configQuery, eventsQuery, useRefreshAuth } from "./queries.ts";

const MFA_REQUIRED = [
  { value: "never", label: "Nobody (optional)" },
  { value: "admins", label: "Admins" },
  { value: "everyone", label: "Everyone" },
];

/** The configuration key each page edits. */
const KEY: Partial<Record<AuthSection, keyof AuthConfig>> = {
  providers: "providers",
  "multi-factor": "multiFactor",
  passkeys: "passkeys",
  "session-lifetime": "sessions",
  "rate-limits": "rateLimits",
  urls: "urls",
  emails: "emails",
};

export const PROVIDER_LABEL: Record<string, string> = {
  "email-password": "Email and password",
  "magic-link": "Magic link",
  google: "Google",
  github: "GitHub",
  apple: "Apple",
  microsoft: "Microsoft",
  passkey: "Passkey",
};

function Field(props: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {props.label}
      </label>
      {props.children(id)}
      {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
    </div>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (on: boolean) => void; hint?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={props.checked}
        onCheckedChange={(on) => props.onChange(on === true)}
        className="mt-0.5"
      />
      <div>
        <label htmlFor={id} className="text-sm">
          {props.label}
        </label>
        {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
      </div>
    </div>
  );
}

const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The form of one page, over a draft of its part of the configuration. */
function Form<K extends keyof AuthConfig>(props: {
  k: K;
  value: AuthConfig[K];
  set: (v: AuthConfig[K]) => void;
}): ReactNode {
  const { k } = props;
  if (k === "providers") {
    const v = props.value as AuthConfig["providers"];
    const set = props.set as (v: AuthConfig["providers"]) => void;
    return (
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm text-muted-foreground">The ways users may sign in.</legend>
        {v.map((p, i) => (
          <div key={p.id} className="flex flex-wrap items-center gap-3 border p-3">
            <Toggle
              label={PROVIDER_LABEL[p.id] ?? p.id}
              checked={p.enabled}
              onChange={(enabled) => set(v.map((x, j) => (j === i ? { ...x, enabled } : x)))}
            />
            {p.clientId !== undefined && (
              <Input
                aria-label={`${PROVIDER_LABEL[p.id] ?? p.id} client ID`}
                className="h-8 max-w-sm flex-1 font-mono text-xs"
                value={p.clientId}
                onChange={(e) => set(v.map((x, j) => (j === i ? { ...x, clientId: e.target.value } : x)))}
              />
            )}
          </div>
        ))}
      </fieldset>
    );
  }
  if (k === "multiFactor") {
    const v = props.value as AuthConfig["multiFactor"];
    const set = props.set as (v: AuthConfig["multiFactor"]) => void;
    return (
      <div className="flex flex-col gap-3">
        <Toggle label="Authenticator apps (TOTP)" checked={v.totp} onChange={(totp) => set({ ...v, totp })} />
        <Toggle label="One-time codes by email" checked={v.otpEmail} onChange={(otpEmail) => set({ ...v, otpEmail })} />
        <Toggle label="Backup codes" checked={v.backupCodes} onChange={(backupCodes) => set({ ...v, backupCodes })} />
        <Field label="Required for">
          {(id) => (
            // the design system's Select, not the browser's (UX2-3)
            <Select
              items={MFA_REQUIRED}
              value={v.required}
              onValueChange={(required) => set({ ...v, required: required as typeof v.required })}
            >
              <SelectTrigger id={id} className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MFA_REQUIRED.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      </div>
    );
  }
  if (k === "passkeys") {
    const v = props.value as AuthConfig["passkeys"];
    const set = props.set as (v: AuthConfig["passkeys"]) => void;
    return (
      <div className="flex flex-col gap-3">
        <Toggle label="Sign in with a passkey" checked={v.enabled} onChange={(enabled) => set({ ...v, enabled })} />
        <Field label="Relying party name" hint="What the browser shows when it asks for the passkey.">
          {(id) => (
            <Input
              id={id}
              className="h-8 max-w-sm"
              value={v.rpName}
              onChange={(e) => set({ ...v, rpName: e.target.value })}
            />
          )}
        </Field>
        <Field label="Relying party ID" hint="Your app's domain; passkeys are bound to it.">
          {(id) => (
            <Input
              id={id}
              className="h-8 max-w-sm font-mono text-xs"
              value={v.rpId}
              onChange={(e) => set({ ...v, rpId: e.target.value })}
            />
          )}
        </Field>
      </div>
    );
  }
  if (k === "sessions") {
    const v = props.value as AuthConfig["sessions"];
    const set = props.set as (v: AuthConfig["sessions"]) => void;
    return (
      <div className="flex flex-col gap-3">
        <Field label="Session lifetime (days)">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              className="h-8 w-32"
              value={v.expiresInSeconds / 86_400}
              onChange={(e) => set({ ...v, expiresInSeconds: Math.round(num(e.target.value) * 86_400) })}
            />
          )}
        </Field>
        <Field label="Refresh after (hours)" hint="A session used after this long is extended.">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              className="h-8 w-32"
              value={v.updateAgeSeconds / 3_600}
              onChange={(e) => set({ ...v, updateAgeSeconds: Math.round(num(e.target.value) * 3_600) })}
            />
          )}
        </Field>
        <Field label="Fresh for (minutes)" hint="Sensitive actions need a sign-in this recent.">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              className="h-8 w-32"
              value={v.freshAgeSeconds / 60}
              onChange={(e) => set({ ...v, freshAgeSeconds: Math.round(num(e.target.value) * 60) })}
            />
          )}
        </Field>
      </div>
    );
  }
  if (k === "rateLimits") {
    const v = props.value as AuthConfig["rateLimits"];
    const set = props.set as (v: AuthConfig["rateLimits"]) => void;
    return (
      <div className="flex flex-col gap-3">
        <Toggle label="Limit auth requests" checked={v.enabled} onChange={(enabled) => set({ ...v, enabled })} />
        <Field label="Requests per window">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              className="h-8 w-32"
              value={v.max}
              onChange={(e) => set({ ...v, max: num(e.target.value) })}
            />
          )}
        </Field>
        <Field label="Window (seconds)">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              className="h-8 w-32"
              value={v.windowSeconds}
              onChange={(e) => set({ ...v, windowSeconds: num(e.target.value) })}
            />
          )}
        </Field>
      </div>
    );
  }
  if (k === "urls") {
    const v = props.value as AuthConfig["urls"];
    const set = props.set as (v: AuthConfig["urls"]) => void;
    return (
      <div className="flex flex-col gap-3">
        <Field label="Site URL" hint="Where emails link to, and the default redirect after sign-in.">
          {(id) => (
            <Input
              id={id}
              className="h-8 max-w-md font-mono text-xs"
              value={v.siteUrl}
              onChange={(e) => set({ ...v, siteUrl: e.target.value })}
            />
          )}
        </Field>
        <Field label="Redirect allow-list" hint="One URL per line; * matches the rest of a path.">
          {(id) => (
            <Textarea
              id={id}
              rows={5}
              className="max-w-md font-mono text-xs"
              value={v.redirectAllowList.join("\n")}
              onChange={(e) => set({ ...v, redirectAllowList: e.target.value.split("\n") })}
            />
          )}
        </Field>
      </div>
    );
  }
  const v = props.value as AuthConfig["emails"];
  const set = props.set as (v: AuthConfig["emails"]) => void;
  return (
    <div className="flex flex-col gap-6">
      {(Object.keys(EMAIL_NAMES) as AuthEmailKind[]).map((kind) => (
        <EmailTemplate key={kind} kind={kind} value={v[kind]} onChange={(t) => set({ ...v, [kind]: t })} />
      ))}
    </div>
  );
}

const EMAIL_NAMES: Record<AuthEmailKind, string> = {
  "verify-email": "Verify email",
  "password-reset": "Reset password",
  "magic-link": "Magic link",
  invitation: "Invitation",
};

/** One template: subject and body with the variables it may use, and a preview as the recipient sees it. */
function EmailTemplate(props: {
  kind: AuthEmailKind;
  value: { subject: string; body: string };
  onChange: (v: { subject: string; body: string }) => void;
}) {
  const { kind, value } = props;
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const unknown = [...new Set([...unknownVariables(kind, value.subject), ...unknownVariables(kind, value.body)])];
  const warnId = useId();
  // inserts at the caret (or at the end), then puts the caret after it
  const insert = (name: string) => {
    const el = bodyRef.current;
    const token = `{{${name}}}`;
    const at = el?.selectionStart ?? value.body.length;
    const end = el?.selectionEnd ?? at;
    props.onChange({ ...value, body: value.body.slice(0, at) + token + value.body.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };
  return (
    <section aria-label={EMAIL_NAMES[kind]} className="grid gap-4 border p-3 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-2">
        <h2 className="text-sm font-medium">{EMAIL_NAMES[kind]}</h2>
        <Field label="Subject">
          {(id) => (
            <Input
              id={id}
              className="h-8"
              value={value.subject}
              onChange={(e) => props.onChange({ ...value, subject: e.target.value })}
            />
          )}
        </Field>
        <Field label="Body" hint="Plain text (links and line breaks are kept) or HTML.">
          {(id) => (
            <Textarea
              id={id}
              ref={bodyRef}
              rows={6}
              className="font-mono text-xs"
              value={value.body}
              aria-invalid={unknown.length > 0 ? true : undefined}
              aria-describedby={unknown.length > 0 ? warnId : undefined}
              onChange={(e) => props.onChange({ ...value, body: e.target.value })}
            />
          )}
        </Field>
        <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0">
          <legend className="float-left mr-1.5 text-xs text-muted-foreground">Insert a variable</legend>
          {EMAIL_VARIABLES[kind].map((name) => (
            <Button
              key={name}
              type="button"
              size="xs"
              variant="outline"
              className="font-mono"
              aria-label={`Insert {{${name}}} into the ${EMAIL_NAMES[kind]} body`}
              onClick={() => insert(name)}
            >
              {`{{${name}}}`}
            </Button>
          ))}
        </fieldset>
        {unknown.length > 0 && (
          <p id={warnId} className="text-xs text-destructive">
            {`Not filled in by this email, so it reaches the recipient as written: ${unknown.map((n) => `{{${n}}}`).join(", ")}`}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">Preview, with sample values</h3>
          <fieldset className="m-0 flex gap-1 border-0 p-0">
            <legend className="sr-only">{`Preview theme of ${EMAIL_NAMES[kind]}`}</legend>
            {(["light", "dark"] as const).map((t) => (
              <Button
                key={t}
                type="button"
                size="xs"
                variant={theme === t ? "secondary" : "ghost"}
                aria-pressed={theme === t}
                onClick={() => setTheme(t)}
              >
                {t === "light" ? "Light" : "Dark"}
              </Button>
            ))}
          </fieldset>
        </div>
        {/* no scripts, no same origin: a template's HTML cannot reach the dashboard */}
        <iframe
          title={`Preview of the ${EMAIL_NAMES[kind]} email`}
          sandbox=""
          srcDoc={renderEmail(kind, value, theme)}
          className="h-64 w-full border bg-background"
        />
      </div>
    </section>
  );
}

export function ConfigPage({ section }: { section: AuthSection }) {
  const scope = useQueryScope();
  const config = useQuery(configQuery(scope));
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const canWrite =
    typeof scope.source.updateAuthConfig === "function" &&
    caps !== undefined &&
    !caps.readOnly &&
    caps.operations.includes("writeData");
  const key = KEY[section]!;
  const [draft, setDraft] = useState<AuthConfig[typeof key]>();
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string }>();
  const [busy, setBusy] = useState(false);
  const refresh = useRefreshAuth();
  // fresh data starts the draft again; a new page also forgets what was said
  useEffect(() => setDraft(config.data?.[key]), [config.data, key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new page clears the message
  useEffect(() => setOutcome(undefined), [key]);
  if (typeof scope.source.getAuthConfig !== "function")
    return <p className="text-sm text-muted-foreground">This deployment does not offer the auth configuration.</p>;
  if (config.error) return <ErrorState error={toDataSourceError(config.error)} />;
  if (!config.data || draft === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const changed = JSON.stringify(draft) !== JSON.stringify(config.data[key]);
  return (
    <div className={`flex flex-col gap-6 ${key === "emails" ? "max-w-6xl" : "max-w-3xl"}`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await scope.source.updateAuthConfig!({ [key]: draft } as Partial<AuthConfig>);
            setOutcome({ ok: true, message: "Saved." });
            await refresh();
          } catch (err) {
            setOutcome({ ok: false, message: `Could not save: ${toDataSourceError(err).message}` });
          }
          setBusy(false);
        }}
      >
        <fieldset disabled={!canWrite} className="contents">
          <Form k={key} value={draft} set={setDraft} />
        </fieldset>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={!canWrite || !changed || busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!changed}
            onClick={() => setDraft(config.data[key])}
          >
            Discard
          </Button>
          <p
            role={outcome && !outcome.ok ? "alert" : "status"}
            className={outcome?.ok === false ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
          >
            {outcome?.message ?? (canWrite ? "" : "This credential cannot change the configuration.")}
          </p>
        </div>
      </form>
      {section === "providers" && <TokenProviders />}
    </div>
  );
}

const eventCol = dataTableColumns<AuthEvent>();

export function AuditPage({ heading }: { heading: ReactNode }) {
  const scope = useQueryScope();
  const events = useQuery(eventsQuery(scope));
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={BAR1}>{heading}</div>
      {events.error ? (
        <ErrorState error={toDataSourceError(events.error)} />
      ) : (
        <AuthEventsTable label="Auth audit log" events={events.data} pending={events.isPending} fill />
      )}
    </div>
  );
}

export function AuthEventsTable(props: { label: string; events?: AuthEvent[]; pending: boolean; fill?: boolean }) {
  const columns: DataTableColumn<AuthEvent>[] = [
    eventCol.accessor((e) => e.time, {
      id: "time",
      header: "Time",
      cell: (c) => <span className="font-mono text-xs tabular-nums">{formatTime(c.getValue())}</span>,
    }),
    eventCol.accessor((e) => e.action, {
      id: "action",
      header: "Action",
      cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span>,
    }),
    eventCol.accessor((e) => e.actor, { id: "actor", header: "By" }),
    eventCol.accessor((e) => JSON.stringify(e.metadata), {
      id: "details",
      header: "Details",
      cell: (c) => (
        <span className="truncate font-mono text-xs text-muted-foreground">
          {c.getValue() === "{}" ? "" : c.getValue()}
        </span>
      ),
    }),
  ];
  return (
    <DataTable
      label={props.label}
      fill={props.fill}
      className={props.fill ? undefined : "max-h-96"}
      columns={columns}
      data={props.events ?? []}
      getRowId={(e) => e.id}
      defaultColumnWidth={(id) => ({ time: 180, action: 160, actor: 200, details: 320 })[id] ?? 160}
      empty={props.pending ? "Loading…" : "Nothing recorded yet."}
    />
  );
}

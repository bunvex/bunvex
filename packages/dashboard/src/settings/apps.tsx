// Settings → Apps (UI-01 §33.2, STUDY-12 §21): the optional registry that names the clients — a bunvex
// addition, like Firebase's or Appwrite's apps (Convex knows a client only by its `Convex-Client` header).
// Registering is never needed to connect: a registered app only names the clients whose `app.id` is among its
// identifiers ("Shop iOS" for `com.acme.shop` on iOS), in Topology, Logs and Auth. Each app shows the versions
// its clients reported and when one last connected; adding, changing and removing one are confirmed when they
// change which clients it names. Last, how a client says who it is — the planned `@bunvex/client` API, marked so.
import { Button } from "@bunvex/ui/components/button";
import { ChoiceSelect } from "@bunvex/ui/components/choice-select";
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { Input } from "@bunvex/ui/components/input";
import { Textarea } from "@bunvex/ui/components/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useId, useState } from "react";
import { clientAppsKey, useClientApps } from "../clients/queries.ts";
import { PLATFORM_LABEL, PlatformIcon } from "../clients/words.tsx";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery } from "../data/queries.ts";
import {
  CLIENT_PLATFORMS,
  type ClientApp,
  type ClientAppInput,
  type ClientPlatform,
  toDataSourceError,
} from "../data-source.ts";
import { formatCount, timeAgo } from "../screens/stats.ts";
import { ConfirmButton } from "../shell/confirm.tsx";
import { ErrorState } from "../shell/error-state.tsx";
import { NotOffered } from "../shell/not-offered.tsx";
import { BarActions, SettingsLayout } from "./layout.tsx";

const PLATFORM_OPTIONS = CLIENT_PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABEL[p] }));

/** What an identifier is on each platform, for the form's hint. */
const IDENTIFIER_HINT: Partial<Record<ClientPlatform, string>> = {
  web: "The site's origin, e.g. https://shop.example.com",
  ios: "The bundle identifier, e.g. com.example.shop",
  swift: "The bundle identifier, e.g. com.example.shop",
  android: "The package name, e.g. com.example.shop",
  kotlin: "The package name, e.g. com.example.shop",
  expo: "The bundle identifier or package name",
  "react-native": "The bundle identifier or package name",
};

export function AppsSettingsScreen() {
  const { source } = useQueryScope();
  if (typeof source.listClientApps !== "function") return <NotOffered title="Settings" what="apps" />;
  return (
    <SettingsLayout title="Apps" description="Names for the clients that connect">
      <Apps />
    </SettingsLayout>
  );
}

function Apps() {
  const scope = useQueryScope();
  const { source } = scope;
  const queryClient = useQueryClient();
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const canView = caps?.operations.includes("viewMetrics") ?? true;
  const canWrite =
    caps !== undefined &&
    !caps.readOnly &&
    caps.operations.includes("writeData") &&
    typeof source.createClientApp === "function";
  const apps = useClientApps();
  /** The app being edited: its id, or "new". */
  const [editing, setEditing] = useState<string>();
  const [outcome, setOutcome] = useState<string>();
  const refresh = () => queryClient.invalidateQueries({ queryKey: clientAppsKey(scope.scope) });

  if (!canView) return <p className="text-sm text-muted-foreground">This credential cannot view the apps.</p>;
  if (apps.error) return <ErrorState error={toDataSourceError(apps.error)} />;
  if (!apps.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const list = apps.data;

  const saved = async (message: string) => {
    setEditing(undefined);
    setOutcome(message);
    await refresh();
  };

  return (
    <div className="flex max-w-4xl flex-col gap-10">
      <section aria-label="Registered apps" className="flex flex-col gap-4">
        <BarActions>
          {canWrite && (
            <Button
              size="sm"
              variant="outline"
              disabled={editing === "new"}
              onClick={() => {
                setEditing("new");
                setOutcome(undefined);
              }}
            >
              <Plus aria-hidden="true" />
              Register an app
            </Button>
          )}
        </BarActions>
        <p className="text-sm text-muted-foreground">
          Every client says which platform, SDK and app it is when it connects; registering is not needed to connect. A
          registered app names the clients whose app id is among its identifiers — in Topology, Logs and Authentication.
        </p>
        {editing === "new" && (
          <AppForm
            onCancel={() => setEditing(undefined)}
            onSave={async (input) => {
              const made = await source.createClientApp!(input);
              await saved(`Registered ${made.name}.`);
            }}
          />
        )}
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No app registered yet: clients are named by their platform and app id.
          </p>
        ) : (
          <ul aria-label="Apps" className="flex flex-col divide-y border">
            {list.map((app) =>
              editing === app.id ? (
                <li key={app.id} className="p-3">
                  <AppForm
                    app={app}
                    onCancel={() => setEditing(undefined)}
                    onSave={async (input) => {
                      const changed = await source.updateClientApp!(app.id, input);
                      await saved(`Saved ${changed.name}.`);
                    }}
                  />
                </li>
              ) : (
                <AppRow
                  key={app.id}
                  app={app}
                  canWrite={canWrite}
                  onEdit={() => {
                    setEditing(app.id);
                    setOutcome(undefined);
                  }}
                  onDelete={async () => {
                    await source.deleteClientApp!(app.id);
                    await saved(`Removed ${app.name}.`);
                  }}
                />
              ),
            )}
          </ul>
        )}
        <p role="status" className="min-h-5 text-sm text-muted-foreground">
          {outcome}
        </p>
      </section>
      <SetupSnippet apps={list} />
    </div>
  );
}

function AppRow(props: { app: ClientApp; canWrite: boolean; onEdit: () => void; onDelete: () => Promise<void> }) {
  const { app } = props;
  const now = Date.now();
  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start" data-testid="client-app">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <PlatformIcon platform={app.platform} className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">{app.name}</span>
          <span className="text-xs text-muted-foreground">{PLATFORM_LABEL[app.platform]}</span>
        </div>
        <p className="flex flex-wrap gap-x-3 font-mono text-xs break-all">
          {app.identifiers.map((i) => (
            <span key={i}>{i}</span>
          ))}
        </p>
        {app.notes && <p className="text-xs text-muted-foreground">{app.notes}</p>}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Last seen</dt>
          <dd>{app.lastSeen === null ? "Never connected" : timeAgo(app.lastSeen, now)}</dd>
          <dt className="text-muted-foreground">Versions seen</dt>
          <dd>
            {app.versionsSeen.length === 0 ? (
              "None yet"
            ) : (
              <ul aria-label={`${app.name} versions seen`} className="flex flex-wrap gap-1.5">
                {app.versionsSeen.map((v) => (
                  <li key={v.version} className="border px-1.5 font-mono tabular-nums">
                    {v.version}
                    <span className="text-muted-foreground"> · {formatCount(v.connections)}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
      </div>
      {props.canWrite && (
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={props.onEdit} aria-label={`Edit ${app.name}`}>
            Edit
          </Button>
          <ConfirmButton
            label="Remove"
            variant="destructive-outline"
            title={`Remove ${app.name}?`}
            description={
              <>
                Its clients keep connecting; the dashboard names them by their platform and app id again (
                <span className="font-mono">{app.identifiers.join(", ")}</span>).
              </>
            }
            confirm="Remove app"
            busy="Removing…"
            keep="Keep it"
            action={props.onDelete}
          />
        </div>
      )}
    </li>
  );
}

const splitIdentifiers = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function AppForm(props: { app?: ClientApp; onSave: (input: ClientAppInput) => Promise<void>; onCancel: () => void }) {
  const id = useId();
  const [name, setName] = useState(props.app?.name ?? "");
  const [platform, setPlatform] = useState<ClientPlatform>(props.app?.platform ?? "web");
  const [identifiers, setIdentifiers] = useState(props.app?.identifiers.join("\n") ?? "");
  const [notes, setNotes] = useState(props.app?.notes ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const ids = splitIdentifiers(identifiers);
  const input: ClientAppInput = { name: name.trim(), platform, identifiers: ids, notes: notes.trim() || undefined };
  const problem = !input.name ? "An app needs a name." : ids.length === 0 ? "Add at least one identifier." : undefined;
  // what stops being named by this app: identifiers dropped, or the platform changed
  const dropped = props.app
    ? platform !== props.app.platform
      ? props.app.identifiers
      : props.app.identifiers.filter((i) => !ids.includes(i))
    : [];
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await props.onSave(input);
    } catch (e) {
      setError(toDataSourceError(e).message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      aria-label={props.app ? `Edit ${props.app.name}` : "Register an app"}
      className="flex flex-col gap-3 border bg-muted/30 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && dropped.length === 0) void save().catch(() => {});
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-name`} className="text-xs font-medium">
            Name
          </label>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Shop iOS" />
        </div>
        <div className="flex flex-col gap-1">
          <span id={`${id}-platform`} className="text-xs font-medium">
            Platform
          </span>
          <ChoiceSelect
            aria-labelledby={`${id}-platform`}
            value={platform}
            onValueChange={setPlatform}
            options={PLATFORM_OPTIONS}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-ids`} className="text-xs font-medium">
          Identifiers
        </label>
        <Textarea
          id={`${id}-ids`}
          value={identifiers}
          onChange={(e) => setIdentifiers(e.target.value)}
          rows={2}
          className="font-mono text-xs"
          aria-describedby={`${id}-ids-hint`}
        />
        <p id={`${id}-ids-hint`} className="text-xs text-muted-foreground">
          {IDENTIFIER_HINT[platform] ?? "The app id its clients send"}; one per line.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-notes`} className="text-xs font-medium">
          Notes <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <Input id={`${id}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {problem && <span className="mr-auto text-xs text-muted-foreground">{problem}</span>}
        <Button type="button" size="sm" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        {dropped.length > 0 ? (
          <ConfirmButton
            label="Save"
            variant="default"
            confirmVariant="default"
            disabled={busy || !!problem}
            title={`Save ${input.name}?`}
            description={
              <>
                Clients with <span className="font-mono">{dropped.join(", ")}</span> will no longer be named{" "}
                {props.app!.name}.
              </>
            }
            confirm="Save"
            busy="Saving…"
            keep="Go back"
            action={save}
          />
        ) : (
          <Button type="submit" size="sm" disabled={busy || !!problem}>
            {busy ? "Saving…" : props.app ? "Save" : "Register"}
          </Button>
        )}
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ how a client says who it is

type SnippetLang = "ts" | "swift" | "kotlin";
const LANG_OF: Partial<Record<ClientPlatform, SnippetLang>> = {
  ios: "swift",
  swift: "swift",
  android: "kotlin",
  kotlin: "kotlin",
};

/** The planned `@bunvex/client` API (STUDY-12 §21.3): illustrative, the SDKs are not released. */
export function setupSnippet(platform: ClientPlatform, appId?: string): string {
  const lang = LANG_OF[platform] ?? "ts";
  if (lang === "swift")
    return `import Bunvex

// bunvex-swift sends the platform, its version and the device itself
let client = BunvexClient(
  deploymentUrl: "https://your-deployment.example.com",
  app: .init(
    id: ${appId ? `"${appId}"` : "Bundle.main.bundleIdentifier"},
    version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
    build: Bundle.main.infoDictionary?["CFBundleVersion"] as? String
  )
)`;
  if (lang === "kotlin")
    return `import dev.bunvex.BunvexClient
import dev.bunvex.AppInfo

// bunvex-kotlin sends the platform, its version and the device itself
val client = BunvexClient(
    deploymentUrl = "https://your-deployment.example.com",
    app = AppInfo(
        id = ${appId ? `"${appId}"` : "BuildConfig.APPLICATION_ID"},
        version = BuildConfig.VERSION_NAME,
        build = BuildConfig.VERSION_CODE.toString(),
    ),
)`;
  const id =
    platform === "web"
      ? "    // on the web the page's origin is sent: no id needed\n"
      : `    id: "${appId ?? "com.example.app"}",\n`;
  return `import { BunvexClient } from "@bunvex/client";

// the SDK sends its name, version and runtime itself
const client = new BunvexClient("https://your-deployment.example.com", {
  app: {
${id}    version: "1.4.0",${platform === "web" ? "" : '\n    build: "42",'}
  },${platform === "web" || platform === "bun" || platform === "node" || platform === "deno" ? `\n  environment: "production",` : ""}
});`;
}

function SetupSnippet({ apps }: { apps: ClientApp[] }) {
  const id = useId();
  const [platform, setPlatform] = useState<ClientPlatform>(apps[0]?.platform ?? "web");
  const appId = apps.find((a) => a.platform === platform)?.identifiers[0];
  const code = setupSnippet(platform, platform === "web" ? undefined : appId);
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${id}-title`} className="text-sm font-medium">
          How a client says who it is
        </h2>
        <span className="border border-warning/50 px-1.5 text-xs text-warning">Planned API</span>
      </div>
      <p className="text-sm text-muted-foreground">
        The client SDKs are not released yet: this is how they are meant to identify an app, and may change.
      </p>
      <div className="flex items-center gap-2">
        <span id={`${id}-platform`} className="text-xs font-medium">
          Platform
        </span>
        <ChoiceSelect
          size="sm"
          aria-labelledby={`${id}-platform`}
          value={platform}
          onValueChange={setPlatform}
          options={PLATFORM_OPTIONS}
        />
        <span className="ml-auto">
          <CopyButton text={code} label="Copy the snippet" />
        </span>
      </div>
      <pre
        data-testid="app-setup-snippet"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls must be reachable by keyboard
        tabIndex={0}
        className="overflow-x-auto border bg-muted/40 p-3 font-mono text-xs leading-5"
      >
        <code>{code}</code>
      </pre>
    </section>
  );
}

// The sign-in page of the dashboard host (STUDY-12 §19, UI-01 §31): the deployment URL and its admin key, as
// Convex's self-hosted dashboard asks for them (`DeploymentCredentialsForm.tsx`), plus — a bunvex addition —
// a way into the demo data (the mock), so the screens can be explored without a deployment.
import { Button } from "@bunvex/ui/components/button";
import { Input } from "@bunvex/ui/components/input";
import { Database, Eye, EyeOff, LogIn } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { type AdminCredentials, type AdminKeyCheck, normalizeDeploymentUrl } from "./credentials.ts";

export type LoginScreenProps = {
  /** Checks the credentials; resolves once the deployment has answered. */
  onSubmit: (credentials: AdminCredentials) => Promise<AdminKeyCheck>;
  /** Opens the dashboard on the demo data instead. */
  onDemo: () => void;
  initialDeploymentUrl?: string;
  initialAdminKey?: string;
};

export function LoginScreen(props: LoginScreenProps) {
  const [url, setUrl] = useState(props.initialDeploymentUrl ?? "");
  const [key, setKey] = useState(props.initialAdminKey ?? "");
  const [showKey, setShowKey] = useState(false);
  const [urlError, setUrlError] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const [busy, setBusy] = useState(false);
  const urlId = useId();
  const urlHint = useId();
  const keyId = useId();
  const keyHint = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const normal = normalizeDeploymentUrl(url);
    if (!normal.ok) return setUrlError(normal.error);
    setUrlError(undefined);
    setRefused(undefined);
    setBusy(true);
    const check = await props.onSubmit({ deploymentUrl: normal.url, adminKey: key.trim() });
    setBusy(false);
    if (!check.ok) setRefused(check.error);
  };

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold tracking-tight">bunvex</p>
          <h1 className="text-xl font-semibold tracking-tight text-balance">Sign in to a deployment</h1>
          <p className="text-sm text-muted-foreground">
            The deployment's URL and an admin key. The CLI prints both when it starts a deployment.
          </p>
        </div>

        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={urlId} className="text-sm font-medium">
              Deployment URL
            </label>
            <Input
              id={urlId}
              name="deploymentUrl"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="http://127.0.0.1:3210"
              value={url}
              aria-invalid={urlError ? true : undefined}
              aria-describedby={urlHint}
              onChange={(e) => {
                setUrl(e.target.value);
                setUrlError(undefined);
                setRefused(undefined);
              }}
              autoFocus
            />
            <p id={urlHint} className={urlError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {urlError ?? "Where the deployment listens, e.g. http://127.0.0.1:3210."}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={keyId} className="text-sm font-medium">
              Admin key
            </label>
            <div className="flex gap-1">
              <Input
                id={keyId}
                name="adminKey"
                type={showKey ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                placeholder="name|…"
                className="font-mono"
                value={key}
                aria-describedby={keyHint}
                onChange={(e) => {
                  setKey(e.target.value);
                  setRefused(undefined);
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Show the admin key"
                aria-pressed={showKey}
                onClick={() => setShowKey((s) => !s)}
              >
                {showKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </Button>
            </div>
            <p id={keyHint} className="text-xs text-muted-foreground">
              Asked every time you open the dashboard; it is never stored.
            </p>
          </div>

          {refused && (
            <p role="alert" className="border border-destructive/40 px-3 py-2 text-sm text-destructive">
              {refused}
            </p>
          )}

          <Button type="submit" className="self-end" disabled={!url.trim() || !key.trim() || busy}>
            <LogIn aria-hidden="true" />
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <div className="flex flex-col gap-2 border-t pt-6">
          <Button type="button" variant="outline" onClick={props.onDemo}>
            <Database aria-hidden="true" />
            Use the demo data
          </Button>
          <p className="text-xs text-muted-foreground">
            Sample tables, functions and logs that live in this browser. Nothing is sent anywhere.
          </p>
        </div>
      </div>
    </main>
  );
}

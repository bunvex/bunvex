// The dashboard host: mounts @bunvex/dashboard, with plain paths (`/database/users`, the browser history) and the
// TanStack devtools in development. A host serving the build answers every path with index.html (Vite's dev
// server and `vite preview` do). It opens on a sign-in page (STUDY-12 §19, UI-01 §31): a deployment URL and admin
// key, checked against the deployment (`check_admin_key`, as Convex's self-hosted dashboard), then the screens run
// on the deployment itself (`@bunvex/dashboard-source`, STUDY-149 PR 6) — or on the demo data (the
// MockDataSource), which needs no deployment. A build for the CLI's local dashboard signs in by itself with the
// credentials its server hands out (`VITE_BUNVEX_USE_CURRENT_DEPLOYMENT=1`).
import { Dashboard } from "@bunvex/dashboard";
import type { DashboardDataSource } from "@bunvex/dashboard/data-source";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createAdminKeyVerifier } from "@bunvex/dashboard-source/credentials";
import { ThemeToggle } from "@bunvex/ui/components/theme-toggle";
import { ThemeProvider } from "@bunvex/ui/theme";
import { lazy, StrictMode, Suspense, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { forgetDevKnob, takeDevKnobs } from "./knobs.ts";
import { AccountEntry } from "./login/account-entry.tsx";
import { type AdminCredentials, deploymentNameOf } from "./login/credentials.ts";
import { fetchCurrentDeployment } from "./login/current-deployment.ts";
import { listenForEmbeddedCredentials, readAllowedOrigins } from "./login/embedded.ts";
import { type HostSession, initialSession, rememberDemo } from "./login/host-session.ts";
import { readPrefill } from "./login/prefill.ts";

/** The custom test query's declarations (STUDY-162), a chunk of their own, fetched the first time it opens. */
const loadQueryTypes = () => import("virtual:bunvex-query-types").then((m) => m.default);

// ?latency=300&fail=0.2&writes=500 in the URL exercises loading, errors and live data (knobs.ts);
// ?demo=1 opens the demo data without the sign-in page.
const params = takeDevKnobs({ location, history, storage: sessionStorage });
const verifier = createAdminKeyVerifier();
const USE_CURRENT_DEPLOYMENT = import.meta.env.VITE_BUNVEX_USE_CURRENT_DEPLOYMENT === "1";
// the sign-in page's prefill: the serving server's (the image's environment), else the build's
const prefill = readPrefill(document, {
  deploymentUrl: import.meta.env.VITE_BUNVEX_DEPLOYMENT_URL,
  adminKey: import.meta.env.VITE_BUNVEX_ADMIN_KEY,
});
// the deployment's source (and the sync client under it) is fetched only once signed in: the sign-in page and the
// demo do not load it
const loadServerSource = () => import("@bunvex/dashboard-source");
// the sign-in page is fetched only when shown: the demo's (and a signed-in) first load stays the shell's
const LoginScreen = lazy(() => import("./login/login-screen.tsx").then((m) => ({ default: m.LoginScreen })));

function mockSource() {
  const source = new MockDataSource({
    latencyMs: Number(params.get("latency") ?? 120),
    failRate: Number(params.get("fail") ?? 0),
    // a task inserted (or deleted) every few seconds, so the Database screen has something live to show
    liveWritesMs: Number(params.get("writes") ?? 3000),
    // ?tables=0: a deployment with no tables yet
    tables: params.get("tables") !== "0",
    // about ten calls a minute over the six hours of history, so the charts read as traffic;
    // ?tasks=100000&executions=… for volume, to see how the screens hold up (UI-01 §19.3)
    executions: Number(params.get("executions") ?? 4000),
    // ?nodes=4: a leader and three followers on the Topology screen (UI-01 §22); one node by default, as today
    nodes: Number(params.get("nodes") ?? 1),
    ...(params.has("tasks") && { documents: { tasks: Number(params.get("tasks")) } }),
    // ?components=1: an app using components, for the Database screen's component picker (STUDY-152 §4)
    ...(params.get("components") === "1" && {
      components: [
        { path: "rateLimiter", tables: { rateLimits: [{ name: "send", value: 3, ts: 0 }] } },
        { path: "rateLimiter/shards", tables: { shards: [{ n: 0 }, { n: 1 }] } },
        { path: "oldCounter", state: "unmounted" as const, tables: { counters: [{ name: "visits", value: 42 }] } },
      ],
    }),
  });
  // ?validate=pass|fail: as if a schema had just been pushed, checked against the documents (UI-01 §21.4)
  const validate = params.get("validate");
  if (validate === "pass" || validate === "fail") source.simulateSchemaValidation(validate);
  return source;
}

/**
 * The data source for the session: none signed out, the mock for the demo, the deployment's own once signed in
 * (closed when the session ends). Each comes with a key, so the dashboard remounts on a new source.
 */
let opened = 0;

function useSessionSource(session: HostSession): { source: DashboardDataSource; key: string } | null {
  const [current, setCurrent] = useState<{ source: DashboardDataSource; key: string } | null>(null);
  useEffect(() => {
    if (session.kind === "signed-out") return setCurrent(null);
    if (session.kind === "demo") return setCurrent({ source: mockSource(), key: "demo" });
    let ended = false;
    let close = () => {};
    setCurrent(null);
    void loadServerSource().then(({ createServerDataSource }) => {
      if (ended) return;
      const source = createServerDataSource({ url: session.deploymentUrl, adminKey: session.adminKey });
      close = () => void source.close();
      setCurrent({ source, key: `deployment-${++opened}` });
    });
    return () => {
      ended = true;
      close();
    };
  }, [session]);
  return current;
}

function App() {
  const [session, setSession] = useState<HostSession>(() => initialSession(sessionStorage, params.get("demo") === "1"));
  // a local dashboard's build first asks its server for the deployment (Convex's /api/current_deployment); the
  // sign-in page waits for the answer, so it does not flash
  const [askingServer, setAskingServer] = useState(USE_CURRENT_DEPLOYMENT && session.kind === "signed-out");

  const signIn = useCallback(async (c: AdminCredentials) => {
    const check = await verifier.verify(c.deploymentUrl, c.adminKey);
    if (check.ok)
      setSession({
        kind: "deployment",
        ...c,
        deploymentName: c.deploymentName ?? deploymentNameOf(c.adminKey),
        allowedOps: check.allowedOps,
        isReadOnly: check.isReadOnly,
      });
    return check;
  }, []);
  // an embedding page at an allowed origin may hand the credentials over (embedded.ts; none allowed by default)
  useEffect(() => listenForEmbeddedCredentials(window, readAllowedOrigins(document), (c) => void signIn(c)), [signIn]);
  useEffect(() => {
    if (!askingServer) return;
    void fetchCurrentDeployment()
      .then((c) => (c ? signIn(c) : null))
      .finally(() => setAskingServer(false));
  }, [askingServer, signIn]);

  const signOut = () => {
    rememberDemo(sessionStorage, false);
    forgetDevKnob(sessionStorage, "demo");
    setSession({ kind: "signed-out" });
  };
  const current = useSessionSource(session);

  if (askingServer) return null;
  if (session.kind === "signed-out")
    return (
      <Suspense fallback={null}>
        <LoginScreen
          onSubmit={signIn}
          onDemo={() => {
            rememberDemo(sessionStorage, true);
            setSession({ kind: "demo" });
          }}
          // prefilled as Convex's NEXT_PUBLIC_DEPLOYMENT_URL / NEXT_PUBLIC_ADMIN_KEY (login/prefill.ts)
          initialDeploymentUrl={prefill.deploymentUrl}
          initialAdminKey={prefill.adminKey}
        />
      </Suspense>
    );
  // the deployment's source is on its way (its module, the first time)
  if (!current) return null;
  return (
    <Dashboard
      key={current.key}
      dataSource={current.source}
      headerActions={
        <>
          {session.kind === "demo" ? (
            <AccountEntry kind="demo" onSignOut={signOut} />
          ) : (
            <AccountEntry
              kind="deployment"
              deploymentUrl={session.deploymentUrl}
              deploymentName={session.deploymentName}
              readOnly={session.isReadOnly}
              onSignOut={signOut}
            />
          )}
          <ThemeToggle />
        </>
      }
      devtools={import.meta.env.DEV}
      traceUrl={import.meta.env.VITE_BUNVEX_TRACE_URL}
      queryTypes={loadQueryTypes}
      {...(session.kind === "deployment" && { deploymentUrl: session.deploymentUrl })}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);

// The dashboard host for development: mounts @bunvex/dashboard, with plain paths (`/database/users`, the
// browser history) and the TanStack devtools in development. A host serving the build answers every path
// with index.html (Vite's dev server and `vite preview` do). It opens on a sign-in page (STUDY-12 §19,
// UI-01 §31): a deployment URL and admin key — checked by the mock verifier for now, the dashboard does not
// talk to a real server yet — or the demo data. Either way the screens run on the MockDataSource.
import { Dashboard } from "@bunvex/dashboard";
import { OPERATIONS } from "@bunvex/dashboard/data-source";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { ThemeToggle } from "@bunvex/ui/components/theme-toggle";
import { ThemeProvider } from "@bunvex/ui/theme";
import { lazy, StrictMode, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { forgetDevKnob, takeDevKnobs } from "./knobs.ts";
import { AccountEntry } from "./login/account-entry.tsx";
import { type AdminCredentials, capabilitiesOf, deploymentNameOf, mockVerifier } from "./login/credentials.ts";
import { listenForEmbeddedCredentials, readAllowedOrigins } from "./login/embedded.ts";
import { type HostSession, initialSession, rememberDemo } from "./login/host-session.ts";

// ?latency=300&fail=0.2&writes=500 in the URL exercises loading, errors and live data (knobs.ts);
// ?demo=1 opens the demo data without the sign-in page.
const params = takeDevKnobs({ location, history, storage: sessionStorage });
const verifier = mockVerifier();
// the sign-in page is fetched only when shown: the demo's (and a signed-in) first load stays the shell's
const LoginScreen = lazy(() => import("./login/login-screen.tsx").then((m) => ({ default: m.LoginScreen })));

function mockSource(session: Exclude<HostSession, { kind: "signed-out" }>) {
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
    // a signed-in key brings its permissions (a read-only key, a viewer key: credentials.ts)
    ...(session.kind === "deployment" && { capabilities: capabilitiesOf(session, OPERATIONS) }),
  });
  // ?validate=pass|fail: as if a schema had just been pushed, checked against the documents (UI-01 §21.4)
  const validate = params.get("validate");
  if (validate === "pass" || validate === "fail") source.simulateSchemaValidation(validate);
  return source;
}

function App() {
  const [session, setSession] = useState<HostSession>(() => initialSession(sessionStorage, params.get("demo") === "1"));

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

  const signOut = () => {
    rememberDemo(sessionStorage, false);
    forgetDevKnob(sessionStorage, "demo");
    setSession({ kind: "signed-out" });
  };
  const source = useMemo(() => (session.kind === "signed-out" ? null : mockSource(session)), [session]);

  if (session.kind === "signed-out" || !source)
    return (
      <Suspense fallback={null}>
        <LoginScreen
          onSubmit={signIn}
          onDemo={() => {
            rememberDemo(sessionStorage, true);
            setSession({ kind: "demo" });
          }}
          // prefilled from the build's environment, as Convex's NEXT_PUBLIC_DEPLOYMENT_URL / NEXT_PUBLIC_ADMIN_KEY
          initialDeploymentUrl={import.meta.env.VITE_BUNVEX_DEPLOYMENT_URL}
          initialAdminKey={import.meta.env.VITE_BUNVEX_ADMIN_KEY}
        />
      </Suspense>
    );
  return (
    <Dashboard
      key={session.kind === "deployment" ? `${session.deploymentUrl}|${session.adminKey}` : "demo"}
      dataSource={source}
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

// What the host shows (STUDY-12 §19): the sign-in page, the demo data, or a deployment it signed in to.
// Like Convex's self-hosted dashboard, a deployment's admin key lives only in memory — a reload asks for it
// again (Convex keeps it in sessionStorage but signs in only from the form, the environment, the embedding
// page or `/api/current_deployment`). The demo choice, which is no secret, is kept for the tab
// (sessionStorage), so reloading the demo stays in the demo.
import type { AdminCredentials } from "./credentials.ts";

export type HostSession =
  | { kind: "signed-out" }
  | { kind: "demo" }
  | ({ kind: "deployment"; allowedOps: string[]; isReadOnly: boolean } & AdminCredentials);

const DEMO_KEY = "bunvex:dashboard-demo";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The session a page load starts in: the demo when the tab chose it (or `?demo=1`), signed out otherwise. */
export function initialSession(storage: Store | undefined, demoKnob: boolean): HostSession {
  try {
    if (demoKnob) storage?.setItem(DEMO_KEY, "1");
    return storage?.getItem(DEMO_KEY) === "1" ? { kind: "demo" } : { kind: "signed-out" };
  } catch {
    return demoKnob ? { kind: "demo" } : { kind: "signed-out" };
  }
}

export function rememberDemo(storage: Store | undefined, on: boolean) {
  try {
    if (on) storage?.setItem(DEMO_KEY, "1");
    else storage?.removeItem(DEMO_KEY);
  } catch {
    // storage off (private window): the choice lasts until the next reload
  }
}

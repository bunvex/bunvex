import { describe, expect, test } from "bun:test";
import { OPERATIONS } from "@bunvex/dashboard/data-source";
import { forgetDevKnob } from "../src/knobs.ts";
import { capabilitiesOf, deploymentNameOf, normalizeDeploymentUrl } from "../src/login/credentials.ts";
import { fetchCurrentDeployment, parseCurrentDeployment } from "../src/login/current-deployment.ts";
import { initialSession, rememberDemo } from "../src/login/host-session.ts";

function memoryStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

describe("the deployment URL", () => {
  test("made canonical: a scheme for a bare host (http locally), no trailing slash", () => {
    expect(normalizeDeploymentUrl(" 127.0.0.1:3210/ ")).toEqual({ ok: true, url: "http://127.0.0.1:3210" });
    expect(normalizeDeploymentUrl("localhost:3210")).toEqual({ ok: true, url: "http://localhost:3210" });
    expect(normalizeDeploymentUrl("api.example.com/convex/")).toEqual({
      ok: true,
      url: "https://api.example.com/convex",
    });
    expect(normalizeDeploymentUrl("https://x.example.com")).toEqual({ ok: true, url: "https://x.example.com" });
  });

  test("refused with a reason", () => {
    expect(normalizeDeploymentUrl("")).toMatchObject({ ok: false, error: "Enter the deployment URL." });
    expect(normalizeDeploymentUrl("ftp://x.example.com").ok).toBe(false);
    expect(normalizeDeploymentUrl("http://x.example.com/?a=1").ok).toBe(false);
    expect(normalizeDeploymentUrl("http://exa mple.com").ok).toBe(false);
  });
});

describe("the current deployment (a local dashboard's build) and the key's permissions", () => {
  test("/api/current_deployment's { name, url, adminKey } signs in; anything else is no deployment", async () => {
    const good = { name: "local-otter", url: "http://127.0.0.1:3210", adminKey: "local-otter|abc" };
    expect(parseCurrentDeployment(good)).toEqual({
      deploymentName: "local-otter",
      deploymentUrl: "http://127.0.0.1:3210",
      adminKey: "local-otter|abc",
    });
    for (const bad of [
      null,
      "x",
      { ...good, url: "not a url" },
      { ...good, url: "ftp://x" },
      { name: "n", url: good.url },
    ])
      expect(parseCurrentDeployment(bad)).toBeNull();
    const asked: string[] = [];
    const answer = (res: Response | Error) => (input: string) => {
      asked.push(input);
      return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
    };
    expect(await fetchCurrentDeployment(answer(Response.json(good)))).toMatchObject({ deploymentName: "local-otter" });
    expect(asked).toEqual(["/api/current_deployment"]);
    expect(await fetchCurrentDeployment(answer(new Response("nope", { status: 404 })))).toBeNull();
    expect(await fetchCurrentDeployment(answer(new Response("<html>")))).toBeNull();
    expect(await fetchCurrentDeployment(answer(new Error("offline")))).toBeNull();
  });

  test("no operations listed means every operation (Convex); Convex's names map to the dashboard's", () => {
    expect(capabilitiesOf({ allowedOps: [], isReadOnly: false }, OPERATIONS).operations).toEqual([...OPERATIONS]);
    expect(
      capabilitiesOf(
        { allowedOps: ["UnpauseDeployment", "RunTestQuery", "RunInternalQueries", "Deploy"], isReadOnly: false },
        OPERATIONS,
      ).operations,
    ).toEqual(["resumeDeployment", "runFunctions"]);
    expect(deploymentNameOf("happy-otter-123|eyJ…")).toBe("happy-otter-123");
  });
});

describe("the host's session", () => {
  test("signed out by default; the demo is remembered for the tab and forgotten on sign-out", () => {
    const s = memoryStorage();
    expect(initialSession(s, false)).toEqual({ kind: "signed-out" });
    rememberDemo(s, true);
    expect(initialSession(s, false)).toEqual({ kind: "demo" });
    rememberDemo(s, false);
    expect(initialSession(s, false)).toEqual({ kind: "signed-out" });
    expect(initialSession(s, true)).toEqual({ kind: "demo" }); // ?demo=1
  });

  test("leaving the demo also forgets the ?demo knob kept for the tab", () => {
    const s = memoryStorage({ "bunvex:dashboard-dev-knobs": "writes=0&demo=1" });
    forgetDevKnob(s, "demo");
    expect(s.m.get("bunvex:dashboard-dev-knobs")).toBe("writes=0");
  });
});

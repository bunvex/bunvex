import { describe, expect, test } from "bun:test";
import { OPERATIONS } from "@bunvex/dashboard/data-source";
import { forgetDevKnob } from "../src/knobs.ts";
import {
  capabilitiesOf,
  deploymentNameOf,
  INVALID_CREDENTIALS,
  mockVerifier,
  normalizeDeploymentUrl,
} from "../src/login/credentials.ts";
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

describe("the mock verifier and the key's permissions", () => {
  test("a Convex-shaped key signs in; a read-only or viewer key narrows the capabilities", async () => {
    const v = mockVerifier(0);
    expect(await v.verify("http://127.0.0.1:3210", "dev|abc")).toEqual({ ok: true, allowedOps: [], isReadOnly: false });
    expect(await v.verify("http://127.0.0.1:3210", "nokey")).toEqual({ ok: false, error: INVALID_CREDENTIALS });
    const ro = await v.verify("http://127.0.0.1:3210", "dev|readonly-1");
    expect(ro).toMatchObject({ ok: true, isReadOnly: true });
    const viewer = await v.verify("http://127.0.0.1:3210", "dev|viewer-1");
    if (!viewer.ok) throw new Error("viewer refused");
    expect(capabilitiesOf(viewer, OPERATIONS)).toEqual({ operations: ["viewData", "viewLogs"], readOnly: true });
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

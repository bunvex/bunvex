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
import { listenForEmbeddedCredentials, parseEmbeddedCredentials } from "../src/login/embedded.ts";
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

describe("credentials from an embedding page", () => {
  test("only a well-formed dashboard-credentials message counts", () => {
    const good = {
      type: "dashboard-credentials",
      adminKey: "k|1",
      deploymentUrl: "http://127.0.0.1:3210/",
      deploymentName: "dev",
    };
    expect(parseEmbeddedCredentials(good)).toEqual({
      adminKey: "k|1",
      deploymentUrl: "http://127.0.0.1:3210",
      deploymentName: "dev",
    });
    expect(parseEmbeddedCredentials({ ...good, type: "other" })).toBeNull();
    expect(parseEmbeddedCredentials({ ...good, deploymentUrl: "127.0.0.1:3210" })).toBeNull();
    expect(parseEmbeddedCredentials("hello")).toBeNull();
  });

  test("asks the parent once, after it listens, and hands each answer over", () => {
    const sent: unknown[] = [];
    let handler: ((e: MessageEvent) => void) | undefined;
    const win = {
      parent: { postMessage: (m: unknown) => void sent.push(m) },
      addEventListener: (_: string, h: EventListener) => {
        handler = h as never;
      },
      removeEventListener: () => {
        handler = undefined;
      },
    };
    const got: unknown[] = [];
    const stop = listenForEmbeddedCredentials(win as never, (c) => got.push(c));
    expect(sent).toEqual([{ type: "dashboard-credentials-request" }]);
    handler!({
      data: {
        type: "dashboard-credentials",
        adminKey: "a|b",
        deploymentUrl: "https://d.example.com",
        deploymentName: "d",
      },
    } as MessageEvent);
    handler!({ data: { type: "nope" } } as MessageEvent);
    expect(got).toEqual([{ adminKey: "a|b", deploymentUrl: "https://d.example.com", deploymentName: "d" }]);
    stop();
    expect(handler).toBeUndefined();
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

// The embedded sign-in (src/login/embedded.ts) in happy-dom: a parent page with the dashboard in an iframe,
// real postMessage between them. Credentials count only from the parent at an allowed origin (STUDY-12 LG3).
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { AdminCredentials } from "../src/login/credentials.ts";
import {
  listenForEmbeddedCredentials,
  parseAllowedOrigins,
  parseEmbeddedCredentials,
  readAllowedOrigins,
} from "../src/login/embedded.ts";

const ADMIN = "https://admin.example.com";
const credentials = {
  type: "dashboard-credentials",
  adminKey: "dev|secret",
  deploymentUrl: "https://d.example.com/",
  deploymentName: "dev",
};

const windows: Window[] = [];
afterEach(async () => {
  for (const w of windows.splice(0)) await w.happyDOM.close();
});

/** A parent page at `origin` that embeds the dashboard; the dashboard listens with `allowed`. */
async function embed(origin: string, allowed: readonly string[]) {
  const parent = new Window({ url: `${origin}/` });
  windows.push(parent);
  const iframe = parent.document.createElement("iframe");
  parent.document.body.appendChild(iframe);
  const dashboard = iframe.contentWindow as unknown as Window;
  const requests: unknown[] = [];
  const targets: string[] = [];
  parent.addEventListener("message", (e) => {
    requests.push((e as unknown as MessageEvent).data);
  });
  const post = parent.postMessage.bind(parent);
  parent.postMessage = ((message: unknown, targetOrigin: string) => {
    targets.push(targetOrigin);
    post(message, targetOrigin);
  }) as typeof parent.postMessage;
  const signedIn: AdminCredentials[] = [];
  const stop = listenForEmbeddedCredentials(dashboard as never, allowed, (c) => signedIn.push(c));
  await settle(parent);
  return { parent, dashboard, requests, targets, signedIn, stop };
}

async function settle(w: Window) {
  await w.happyDOM.waitUntilComplete();
  await new Promise((r) => setTimeout(r, 5));
}

describe("credentials from an embedding page", () => {
  test("only a well-formed dashboard-credentials message counts", () => {
    expect(parseEmbeddedCredentials(credentials)).toEqual({
      adminKey: "dev|secret",
      deploymentUrl: "https://d.example.com",
      deploymentName: "dev",
    });
    expect(parseEmbeddedCredentials({ ...credentials, type: "other" })).toBeNull();
    expect(parseEmbeddedCredentials({ ...credentials, deploymentUrl: "127.0.0.1:3210" })).toBeNull();
    expect(parseEmbeddedCredentials("hello")).toBeNull();
  });

  test("a parent at an allowed origin is asked (addressed to that origin) and signs the dashboard in", async () => {
    const e = await embed(ADMIN, [ADMIN, "http://localhost:3000"]);
    expect(e.requests).toEqual([{ type: "dashboard-credentials-request" }]); // once: delivered at its own origin only
    expect(e.targets).toEqual([ADMIN, "http://localhost:3000"]); // never "*"
    e.dashboard.postMessage(credentials, "*");
    e.dashboard.postMessage({ type: "nope" }, "*");
    await settle(e.parent);
    expect(e.signedIn).toEqual([
      { adminKey: "dev|secret", deploymentUrl: "https://d.example.com", deploymentName: "dev" },
    ]);
    e.stop();
    e.dashboard.postMessage(credentials, "*");
    await settle(e.parent);
    expect(e.signedIn).toHaveLength(1);
  });

  test("a parent at another origin is not asked, and its credentials are ignored", async () => {
    const e = await embed("https://evil.example.com", [ADMIN]);
    expect(e.requests).toEqual([]);
    e.dashboard.postMessage(credentials, "*");
    await settle(e.parent);
    expect(e.signedIn).toEqual([]);
  });

  test("an allowed origin counts only from the parent, not from another window", async () => {
    const e = await embed(ADMIN, [ADMIN]);
    const other = new Window({ url: `${ADMIN}/other` });
    windows.push(other);
    e.dashboard.dispatchEvent(
      new e.dashboard.MessageEvent("message", { data: credentials, origin: ADMIN, source: other as never }),
    );
    await settle(e.parent);
    expect(e.signedIn).toEqual([]);
  });

  test("with no allowed origin, embedded sign-in is off: nothing is asked, nothing is accepted", async () => {
    const e = await embed(ADMIN, []);
    expect(e.requests).toEqual([]);
    expect(e.targets).toEqual([]);
    e.dashboard.postMessage(credentials, "*");
    await settle(e.parent);
    expect(e.signedIn).toEqual([]);
  });
});

describe("the allowed origins", () => {
  test("parsed from commas or spaces, reduced to origins; anything else (or '*') is dropped", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins("*")).toEqual([]);
    expect(
      parseAllowedOrigins(
        " https://admin.example.com/path?q=1, http://localhost:3000\nhttps://admin.example.com ftp://x.y nope",
      ),
    ).toEqual(["https://admin.example.com", "http://localhost:3000"]);
  });

  test("read from index.html's <meta name=bunvex-embed-origins>", () => {
    const w = new Window({ url: "https://dash.example.com/" });
    windows.push(w);
    expect(readAllowedOrigins(w.document as never)).toEqual([]);
    w.document.head.innerHTML = '<meta name="bunvex-embed-origins" content="https://admin.example.com">';
    expect(readAllowedOrigins(w.document as never)).toEqual(["https://admin.example.com"]);
  });
});

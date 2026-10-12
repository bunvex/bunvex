// The unawaited-operations warning (STUDY-143) on Convex's backend (the oracle) and on bunvex's: actions and HTTP
// actions that leave operations pending, their log lines compared — the count, the names and their order, which
// operations count (not a timer; `ctx.meta`, `createFunctionHandle`, a multipart `formData()` do), an action that
// awaited everything (none), and one that timed out (`V8_ACTION_USER_TIMEOUT_SECS=3` on both). Convex's line ends
// with a link to its docs that bunvex's does not have (DV-04), the only rewrite. HTTP actions' lines are read from
// the function log stream (`/api/stream_function_logs`). Local only: skipped, with a note, when Convex's backend is
// not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`unawaited-operations: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../unawaited-app");
const DOCS_LINK = / See https:\/\/docs\.convex\.dev\/functions\/actions#dangling-promises for more information\./;

let convex: Backend;
let bunvex: Backend;
let server: ReturnType<typeof Bun.serve> | undefined;
let url = "";

beforeAll(async () => {
  if (!ready) return;
  // A target that answers after the action is over: its fetch stays pending.
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Bun.sleep(5000).then(() => new Response("late")) });
  url = `http://127.0.0.1:${server.port}/`;
  const env = { V8_ACTION_USER_TIMEOUT_SECS: "3" };
  [convex, bunvex] = await Promise.all([startConvex({ app: APP, env }), startBunvex({ app: APP, env })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
  server?.stop(true);
});

/** An action's status and log lines, Convex's docs link dropped (DV-04). */
async function run(b: Backend, path: string, args: unknown) {
  const r = await fetch(`${b.url}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await r.json()) as { status: string; logLines?: string[] };
  return { status: body.status, logLines: (body.logLines ?? []).map((l) => l.replace(DOCS_LINK, "")) };
}

async function same(path: string, args: unknown) {
  const c = await run(convex, path, args);
  expect(await run(bunvex, path, args)).toEqual(c);
  return c;
}

const leave = (which: string[]) => same("ops:leave", { url, which });

describe.skipIf(!ready)("the unawaited-operations warning, against Convex's backend", () => {
  test("the count, the names sorted and deduplicated, singular and plural", async () => {
    expect((await leave(["fetch"])).logLines).toEqual([
      "[WARN] 1 unawaited operation: [fetch]. Async operations should be awaited or they might not run.",
    ]);
    expect((await leave(["fetch", "fetch", "query"])).logLines).toEqual([
      "[WARN] 3 unawaited operations: [fetch, query]. Async operations should be awaited or they might not run.",
    ]);
  });

  test("ctx's calls, ctx.meta, createFunctionHandle and storage count; a timer does not", async () => {
    expect((await leave(["action", "schedule", "getUrl", "generateUploadUrl", "getUserIdentity"])).logLines).toEqual([
      "[WARN] 5 unawaited operations: [action, getUserIdentity, schedule, storageGenerateUploadUrl, storageGetUrl]. Async operations should be awaited or they might not run.",
    ]);
    expect((await leave(["functionMetadata", "deploymentMetadata", "requestMetadata", "handle"])).logLines).toEqual([
      "[WARN] 4 unawaited operations: [createFunctionHandle, getDeploymentMetadata, getFunctionMetadata, getRequestMetadata]. Async operations should be awaited or they might not run.",
    ]);
    expect((await leave(["store"])).logLines).toEqual([
      "[WARN] 1 unawaited operation: [storage.store]. Async operations should be awaited or they might not run.",
    ]);
    expect((await leave(["timer"])).logLines).toEqual([]);
    // Unawaited, but answered while the action waited: not listed.
    expect((await same("ops:later", {})).logLines).toEqual([]);
  });

  test("an action that awaited everything has no warning", async () => {
    const all = ["query", "getUserIdentity", "functionMetadata", "handle", "generateUploadUrl"];
    expect((await same("ops:awaited", { url, which: all })).logLines).toEqual([]);
  });

  test("an action that timed out lists what was pending then", async () => {
    const r = await same("ops:hang", { url });
    expect(r.status).toBe("error");
    expect(r.logLines).toEqual([
      "[WARN] 1 unawaited operation: [fetch]. Async operations should be awaited or they might not run.",
    ]);
  }, 30_000);

  test("an HTTP action: a multipart formData() and a runQuery left pending; not one answered while its body streamed", async () => {
    const lines = async (b: Backend) => {
      const site = b.url.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`);
      // Its query answers while the body streams (250 ms): Convex handles that answer, so nothing is listed.
      expect(await (await fetch(`${site}/stream`)).text()).toBe("xxxxx");
      const form = new FormData();
      form.append("a", "b");
      form.append("f", new Blob(["x".repeat(100_000)]), "f.txt");
      expect((await fetch(`${site}/form`, { method: "POST", body: form })).status).toBe(200);
      expect((await fetch(`${site}/query`)).status).toBe(200);
      const auth = `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;
      const out: Record<string, string[]> = {};
      for (let i = 0; i < 50 && Object.keys(out).length < 2; i++) {
        const r = await fetch(`${b.url}/api/stream_function_logs?cursor=0`, { headers: { authorization: auth } });
        const { entries } = (await r.json()) as { entries: { identifier: string; logLines: string[] }[] };
        for (const e of entries)
          if (e.identifier.includes("/") && e.logLines.length)
            out[e.identifier] = e.logLines.map((l) => l.replace(DOCS_LINK, ""));
        if (Object.keys(out).length < 2) await Bun.sleep(100);
      }
      return out;
    };
    const c = await lines(convex);
    expect(c).toEqual({
      "POST /form": [
        "[WARN] 1 unawaited operation: [formData]. Async operations should be awaited or they might not run.",
      ],
      "GET /query": [
        "[WARN] 1 unawaited operation: [query]. Async operations should be awaited or they might not run.",
      ],
    });
    expect(await lines(bunvex)).toEqual(c);
  });
});

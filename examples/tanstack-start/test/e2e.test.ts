// The TanStack Start example end to end: its functions deployed to a bunvex-local-backend, its pages built, then
// served by Vite's preview of the built app. A page request returns the messages already rendered on the server
// (the HTML holds them before any script runs); in the browser the page then updates live (examples/_browser).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
let preview: ReturnType<typeof Bun.spawn> | undefined;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(async () => {
  preview?.kill();
  await d?.stop();
});

test("the page is rendered on the server with the messages", async () => {
  await d.http.mutation(api.messages.send, { body: "rendered on the server", author: "Ada" });
  await build(DIR, { VITE_BUNVEX_URL: d.url });
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  preview = Bun.spawn(
    [process.execPath, "--bun", "x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: DIR,
      env: { ...process.env, VITE_BUNVEX_URL: d.url },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let html = "";
  for (let i = 0; i < 100 && !html; i++) {
    html = await fetch(`http://127.0.0.1:${port}/`).then(
      (r) => (r.ok ? r.text() : ""),
      () => "",
    );
    if (!html) await Bun.sleep(100);
  }
  expect(html).toContain("<h1>Chat</h1>");
  // React separates adjacent text nodes with `<!-- -->`.
  expect(html.replaceAll("<!-- -->", "")).toContain("<li>Ada: rendered on the server</li>");
  // The query's result goes to the browser with the page, under its key, for the client to take over from.
  expect(html).toContain("bunvexQuery|messages:list|{}");
}, 300_000);

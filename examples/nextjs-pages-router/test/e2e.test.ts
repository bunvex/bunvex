// The Next.js Pages Router example end to end (STUDY-90): the counter live through the client, `next build`,
// then `next start` serving the page and the API route, which reads the counter on the server (in Node).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fetchQuery } from "bunvex/nextjs";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

test("the counter, live through the client and read on the server", async () => {
  let live: number | undefined;
  d.client().onUpdate(api.counter.get, { name: "clicks" }, (n) => {
    live = n;
  });
  await until(() => live === 0, "the first value");
  await d.http.mutation(api.counter.increment, { name: "clicks", by: 1 });
  await d.http.mutation(api.counter.increment, { name: "clicks", by: 2 });
  await until(() => live === 3, "three clicks");
  expect(await fetchQuery(api.counter.get, { name: "clicks" }, { url: d.url })).toBe(3);
});

test("next build, then next start serves the page and the API route", async () => {
  const env = { NEXT_PUBLIC_BUNVEX_URL: d.url, NEXT_TELEMETRY_DISABLED: "1" };
  await build(DIR, env);
  const port = 33_000 + Math.floor(Math.random() * 6_000);
  const server = Bun.spawn(["bun", "x", "next", "start", "-p", String(port)], {
    cwd: DIR,
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    let page = "";
    for (let i = 0; i < 300 && !page; i++) {
      page = await fetch(url)
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => "");
      if (!page) await Bun.sleep(100);
    }
    expect(page).toContain("A counter");
    // The API route runs `fetchQuery` in Next's server runtime against the deployment.
    expect(await (await fetch(`${url}/api/clicks`)).json()).toEqual({ clicks: 3 });
  } finally {
    server.kill();
    await server.exited;
  }
}, 120_000);

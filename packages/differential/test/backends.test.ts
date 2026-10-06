// The harness starts each backend on ports nothing else holds (STUDY-122): a port taken between the check and
// the start, or held by another server, makes it try again on others, and it never takes another process's
// answers for its backend's.
import { afterAll, expect, test } from "bun:test";
import { startBunvex } from "../harness/backends.ts";

const strangers: { stop: (closeActive?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of strangers) s.stop(true);
});

test("a port held by another server, answering as the instance would: the backend starts elsewhere", async () => {
  // The worst stranger: on the first ports the harness picks, it answers the health route with the very name.
  const stranger = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("differential") });
  strangers.push(stranger);
  const held = stranger.port!;
  const picks: [number, number][] = [];
  let first = true;
  const pickPorts = (): [number, number] => {
    const p: [number, number] = first ? [held, held + 1] : [21_000 + Math.floor(Math.random() * 9_000), 0];
    if (!first) p[1] = p[0] + 1;
    first = false;
    picks.push(p);
    return p;
  };
  const backend = await startBunvex({ pickPorts });
  try {
    expect(picks.length).toBeGreaterThan(1);
    expect(backend.url).not.toContain(`:${held}`);
    // It is the deployed backend: the app answers.
    const dump = await backend.call("query", "ops:dump", {});
    expect(dump.ok).toBe(true);
  } finally {
    await backend.stop();
  }
}, 120_000);

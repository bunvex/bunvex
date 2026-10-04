// The harness itself: what the sync tests rely on.
import { afterEach, expect, test } from "bun:test";
import { BunvexClient } from "@bunvex/client";
import { startServer } from "./harness.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

// Found under load (3 Oct 2026): the restart served the site on the port after the API's (createServer's
// default for a given port), a port the harness never held — on macOS, where ports are handed out in order,
// the first site's, which another socket could take once it was released. The restart threw EADDRINUSE: in a
// test, or inside a commit listener, where it stopped the committer and the whole `bun test` exited.
test("a restart binds the API's port only: another socket on the next port does not stop it", async () => {
  const h = await startServer();
  cleanup.push(h.stop);
  const port = Number(new URL(h.url).port);
  h.stop(); // both ports free; someone takes the next one
  let squatter: { stop(force?: boolean): void } | null = null;
  try {
    squatter = Bun.serve({ port: port + 1, fetch: () => new Response() });
  } catch {} // already taken: the same case
  cleanup.push(() => squatter?.stop(true));
  h.restart();
  const c = new BunvexClient(h.url, { logger: false });
  cleanup.push(() => c.close());
  expect(await c.action("messages:echo", { x: 1 })).toBe(1);
});

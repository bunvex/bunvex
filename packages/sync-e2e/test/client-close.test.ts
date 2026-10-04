// Closing a client (STUDY-65 G-C13, G-C21), as Convex's `react/react_node.test.ts` and
// `browser/sync/client_node.test.ts` check it: a query's callback does not run once `close()` was called, even
// for a transition already on its way; and a process whose client connected, then closed, exits by itself (no
// timer left behind). Differential: each case runs with bunvex's client and with the official one (the oracle).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anyApi } from "@bunvex/client";
import { v1 } from "@bunvex/protocol";
import { BunvexReactClient } from "@bunvex/react";
import { ConvexReactClient } from "convex/react";
import { anyApi as oracleApi } from "convex/server";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** A sync server that answers the first query set with one result, and records what it got. */
function server() {
  const got: string[] = [];
  let ws: Bun.ServerWebSocket<unknown> | null = null;
  const s = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("not a socket", { status: 400 });
    },
    websocket: {
      open(socket) {
        ws = socket;
      },
      message(_ws, data) {
        got.push((JSON.parse(String(data)) as { type: string }).type);
      },
    },
  });
  cleanup.push(() => s.stop(true));
  return {
    address: `http://127.0.0.1:${s.port}`,
    got,
    answer: () =>
      ws!.send(
        v1.encodeServerMessage({
          type: "Transition",
          startVersion: { querySet: 0, identity: 0, ts: 0n },
          endVersion: { querySet: 1, identity: 0, ts: 1n },
          modifications: [{ type: "QueryUpdated", queryId: 0, value: 0, logLines: [], journal: null }],
        }),
      ),
  };
}

type Watchable = {
  watchQuery(ref: unknown, args: object): { onUpdate(cb: () => void): () => void };
  close(): Promise<void>;
};
const reactClients: [string, (address: string) => Watchable, unknown][] = [
  [
    "BunvexReactClient",
    (a) => new BunvexReactClient(a, { unsavedChangesWarning: false }) as never,
    anyApi.myQuery.default,
  ],
  [
    "official ConvexReactClient",
    (a) => new ConvexReactClient(a, { unsavedChangesWarning: false }) as never,
    oracleApi.myQuery.default,
  ],
];

for (const [name, make, query] of reactClients)
  describe(name, () => {
    test("no callback once close() was called, even for a transition on its way (G-C13)", async () => {
      const s = server();
      const client = make(s.address);
      let ran = 0;
      client.watchQuery(query, {}).onUpdate(() => ran++);
      for (let i = 0; i < 400 && !s.got.includes("ModifyQuerySet"); i++) await Bun.sleep(5);
      expect(s.got).toEqual(["Connect", "ModifyQuerySet"]);
      s.answer();
      const closed = client.close();
      expect(ran).toBe(0);
      await closed;
      await Bun.sleep(50);
      expect(ran).toBe(0);
    });
  });

// The process check, as Convex runs its node test in a subprocess: it must exit on its own once closed.
const script = (importLine: string, make: string) => `
${importLine}
const server = Bun.serve({
  port: 0,
  fetch(req, srv) { if (srv.upgrade(req)) return; return new Response("no", { status: 400 }); },
  websocket: { message() {} },
});
const client = ${make};
await new Promise((r) => setTimeout(r, 300));
await client.close();
server.stop(true);
console.log("closed");
`;
const scripts: [string, string][] = [
  [
    "BaseBunvexClient",
    script(
      `import { BaseBunvexClient } from ${JSON.stringify(require.resolve("@bunvex/client"))};`,
      'new BaseBunvexClient("http://127.0.0.1:" + server.port, () => {}, { unsavedChangesWarning: false })',
    ),
  ],
  [
    "official BaseConvexClient",
    script(
      `import { BaseConvexClient } from ${JSON.stringify(require.resolve("convex/browser"))};`,
      'new BaseConvexClient("http://127.0.0.1:" + server.port, () => {}, { unsavedChangesWarning: false })',
    ),
  ],
];
for (const [name, source] of scripts)
  test(`${name}: a process whose client connected and closed exits by itself (G-C21)`, () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-close-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, `${name.replaceAll(" ", "-")}.ts`);
    writeFileSync(file, source);
    const p = Bun.spawnSync([process.execPath, file], { timeout: 15_000, stdout: "pipe", stderr: "pipe" });
    expect(p.stdout.toString()).toContain("closed");
    expect(p.exitCode).toBe(0);
  }, 20_000);

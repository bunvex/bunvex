// An admin key with an identity to act as (Convex's `setAdminAuth(token, identity)` on its React and simple
// clients): the Authenticate message carries the identity, whether the client set it before or after its
// connection existed. Differential: each case runs with bunvex's client and with the official one (the oracle).
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi, BunvexClient } from "@bunvex/client";
import { BunvexReactClient } from "@bunvex/react";
import { ConvexClient } from "convex/browser";
import { ConvexReactClient } from "convex/react";
import { anyApi as oracleApi } from "convex/server";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** A sync server that records every message it gets. */
function server() {
  const got: Record<string, unknown>[] = [];
  const s = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("not a socket", { status: 400 });
    },
    websocket: {
      message(_ws, data) {
        got.push(JSON.parse(String(data)) as Record<string, unknown>);
      },
    },
  });
  cleanup.push(() => s.stop(true));
  return { address: `http://127.0.0.1:${s.port}`, got };
}

async function authenticate(got: Record<string, unknown>[]) {
  for (let i = 0; i < 400 && !got.some((m) => m.type === "Authenticate"); i++) await Bun.sleep(5);
  return got.find((m) => m.type === "Authenticate");
}

const identity = { subject: "user-1", issuer: "https://issuer.example", name: "Ada" };
const expected = { type: "Authenticate", tokenType: "Admin", value: "admin-key", impersonating: identity };

type Client = {
  setAdminAuth(token: string, identity?: object): void;
  watchQuery?(ref: unknown, args: object): { onUpdate(cb: () => void): () => void };
  onUpdate?(ref: unknown, args: object, cb: () => void): unknown;
  close(): Promise<void>;
};
const clients: [string, (address: string) => Client, unknown][] = [
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
  ["BunvexClient", (a) => new BunvexClient(a, { unsavedChangesWarning: false }) as never, anyApi.myQuery.default],
  [
    "official ConvexClient",
    (a) => new ConvexClient(a, { unsavedChangesWarning: false }) as never,
    oracleApi.myQuery.default,
  ],
];

/** Subscribe to a query, which makes a React client create its connection. */
function use(client: Client, query: unknown) {
  if (client.watchQuery) client.watchQuery(query, {}).onUpdate(() => {});
  else client.onUpdate!(query, {}, () => {});
}

for (const [name, make, query] of clients)
  describe(name, () => {
    test("setAdminAuth(key, identity) sends the identity to act as, set before the connection exists", async () => {
      const s = server();
      const client = make(s.address);
      cleanup.push(() => client.close());
      client.setAdminAuth("admin-key", identity);
      use(client, query);
      expect(await authenticate(s.got)).toMatchObject(expected);
    });

    test("setAdminAuth(key, identity) sends the identity to act as, set once the connection exists", async () => {
      const s = server();
      const client = make(s.address);
      cleanup.push(() => client.close());
      use(client, query);
      client.setAdminAuth("admin-key", identity);
      expect(await authenticate(s.got)).toMatchObject(expected);
    });
  });

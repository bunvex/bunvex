// A bunvex server in this process, with the functions the sync tests call, that can drop every socket and
// come back on the same port (a restart, as far as clients can tell).
import { defineSchema, defineTable, Engine, type PaginationOptions } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import {
  action,
  adminKeyCipherKey,
  createServer,
  Functions,
  internalMutation,
  issueAdminKey,
  mutation,
  query,
  type ServerOptions,
} from "@bunvex/server";
import { BunvexError, v } from "@bunvex/values";

export type Harness = Awaited<ReturnType<typeof startServer>>;

const INSTANCE_SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
/** An admin key of the harness's deployment (for `/api/function`). */
export const ADMIN_KEY = issueAdminKey({ instanceName: "harness", cipherKey: adminKeyCipherKey(INSTANCE_SECRET) });

/** `opts` go to `createServer` (e.g. shorter WebSocket heartbeat timings). */
export async function startServer(opts: Partial<ServerOptions> = {}) {
  const engine = await new Engine(
    defineSchema({ messages: defineTable(v.any()), counters: defineTable(v.any()), settings: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: "harness", instanceSecret: INSTANCE_SECRET },
  ).init();
  const runs: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const functions = new Functions(engine).register("messages", {
    list: query(async ({ db }) => (await db.query("messages").collect()).map((m) => m.body)),
    count: query(async ({ db }) => (await db.query("messages").collect()).length),
    send: mutation(async ({ db }, { body }: { body: string }) => {
      runs.push(body);
      await gates.get(body);
      await db.insert("messages", { body });
      return body.toUpperCase();
    }),
    fail: mutation(() => {
      throw new BunvexError({ code: "nope", n: 7n });
    }),
    broken: query(() => {
      throw new BunvexError("query says no");
    }),
    // Fine while there are no messages, an error once there is one: an error that arrives live.
    fragile: query(async ({ db }) => {
      if (await db.query("messages").first()) throw new BunvexError("now broken");
      return "ok";
    }),
    // Newest first. `tight` caps the rows a page may read, so a growing page is split (STUDY-26 §8).
    paged: query(({ db }, { paginationOpts, tight }: { paginationOpts: PaginationOptions; tight?: boolean }) =>
      db
        .query("messages")
        .order("desc")
        .paginate(tight ? { ...paginationOpts, maximumRowsRead: 8 } : paginationOpts),
    ),
    // Its order follows a setting: flipping it changes the query under every page, so a later page's cursor
    // no longer matches (InvalidCursor) and the client must start over.
    flippable: query(async ({ db }, { paginationOpts }: { paginationOpts: PaginationOptions }) => {
      const flipped = (await db.query("settings").first())?.flipped === true;
      return db
        .query("messages")
        .order(flipped ? "asc" : "desc")
        .paginate(paginationOpts);
    }),
    flip: mutation(async ({ db }) => {
      await db.insert("settings", { flipped: true });
    }),
    sendMany: mutation(async ({ db }, { prefix, n }: { prefix: string; n: number }) => {
      for (let i = 0; i < n; i++) await db.insert("messages", { body: `${prefix}${i}` });
    }),
    clear: internalMutation(async ({ db }, { keep }: { keep: string }) => {
      for (const m of await db.query("messages").collect()) if (m.body !== keep) await db.delete(m._id);
      return keep;
    }),
    logged: mutation(() => {
      console.log("hello from a mutation");
    }),
    echoQuery: query((_ctx, { x }: { x: unknown }) => x),
    echo: action(async (_ctx, { x }: { x: unknown }) => {
      await gates.get("action");
      return x;
    }),
  });
  let port = 0;
  // No site port (HTTP actions; no sync test calls one): createServer puts it on the API's port + 1 when the
  // port is given, as a restart gives it, and that port is not the harness' to take (harness.test.ts)
  const serve = (on: number) =>
    createServer({ engine, functions, port: on, sitePort: null, redactLogsToClient: false, ...opts });
  let current = serve(0);
  port = current.server.port!;
  return {
    engine,
    runs,
    url: `http://127.0.0.1:${port}`,
    /** Hold `name`'s mutation (or "action") until the returned function is called. */
    gate(name: string) {
      let open!: () => void;
      gates.set(
        name,
        new Promise<void>((r) => {
          open = r;
        }),
      );
      return () => {
        gates.delete(name);
        open();
      };
    },
    /** Drop every connection now (clients see an abnormal close), and serve again on the same port. */
    restart() {
      current.stop();
      current = serve(port);
    },
    stop: () => current.stop(),
  };
}

export async function until<T>(f: () => T | undefined | false, what = "condition"): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const x = f();
    if (x) return x;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Convex's HTTP clients ask for `format: "convex_encoded_json"`, which bunvex refuses with `BadFormat`: its
 * name is `encoded_json` (DV-307). The oracle tests send their requests through this `fetch`, which renames
 * that one field, so everything else Convex's clients do is still compared with bunvex's.
 */
export function renameFormat(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return ((url: string, init?: RequestInit) =>
    fetch(
      url,
      typeof init?.body === "string"
        ? { ...init, body: init.body.replace('"format":"convex_encoded_json"', '"format":"encoded_json"') }
        : init,
    )) as typeof globalThis.fetch;
}

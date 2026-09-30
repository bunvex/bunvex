// A bunvex server in this process, with the functions the sync tests call, that can drop every socket and
// come back on the same port (a restart, as far as clients can tell).
import { defineSchema, defineTable, Engine, type PaginationOptions } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { action, createServer, Functions, mutation, query } from "@bunvex/server";
import { BunvexError, v } from "@bunvex/values";

export type Harness = Awaited<ReturnType<typeof startServer>>;

export async function startServer() {
  const engine = await new Engine(
    defineSchema({ messages: defineTable(v.any()), counters: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
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
    // Newest first. `tight` caps the rows a page may read, so a growing page is split (STUDY-26 §8).
    paged: query(({ db }, { paginationOpts, tight }: { paginationOpts: PaginationOptions; tight?: boolean }) =>
      db
        .query("messages")
        .order("desc")
        .paginate(tight ? { ...paginationOpts, maximumRowsRead: 8 } : paginationOpts),
    ),
    sendMany: mutation(async ({ db }, { prefix, n }: { prefix: string; n: number }) => {
      for (let i = 0; i < n; i++) await db.insert("messages", { body: `${prefix}${i}` });
    }),
    logged: mutation(() => {
      console.log("hello from a mutation");
    }),
    echo: action(async (_ctx, { x }: { x: unknown }) => {
      await gates.get("action");
      return x;
    }),
  });
  let port = 0;
  let current = createServer({ engine, functions, port: 0, redactLogsToClient: false });
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
      current = createServer({ engine, functions, port, redactLogsToClient: false });
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

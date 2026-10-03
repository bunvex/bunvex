// Scenarios the nemesis runs found (STUDY-57 §5), replayed step by step so each one fails the same way every
// time. A `test.failing` is a known bug: it flips to a failure (remove `.failing`) once the fix lands.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunvexClient } from "@bunvex/client";
import { ServerProcess } from "../src/process.ts";
import { TcpProxy } from "../src/proxy.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

function serverOn(store: string, env?: Record<string, string>) {
  const dataDir = mkdtempSync(join(tmpdir(), "bunvex-jepsen-"));
  const server = new ServerProcess({ store, dataDir, env });
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  cleanup.push(() => server.stop());
  return server;
}

function client(port: number) {
  const c = new BunvexClient(`http://127.0.0.1:${port}`, {
    logger: false,
    webSocket: { defaultInitialBackoffMs: 20, maxBackoffMs: 200 },
  });
  cleanup.push(() => c.close());
  return c;
}

describe("regressions", () => {
  // The skew nemesis (seed 1): after a restart with the clock behind, a document inserted by a transaction
  // that read another one got an earlier _creationTime, so the default order no longer followed commits.
  // Convex floors a transaction's first _creationTime at its snapshot (`CreationTime::for_transaction`,
  // crates/common/src/document.rs: max(wall clock, snapshot ts rounded up to the ms)). Fixed by #271.
  for (const store of ["memory", "sqlite"])
    test(`${store}: _creationTime follows commits across a restart with the clock behind`, async () => {
      const server = serverOn(store);
      let c = client(await server.start({ JEPSEN_CLOCK_SKEW_MS: "3000" }));
      await c.mutation("log:append", { client: 0, seq: 0 });
      await c.close();
      await server.kill();
      c = client(await server.start({ JEPSEN_CLOCK_SKEW_MS: "-3000" }));
      await c.mutation("log:append", { client: 0, seq: 1 }); // reads seq 0 first
      const rows = (await c.query("log:rows", { client: 0, nonce: 1 })) as [number, number][];
      expect(rows.map(([seq]) => seq)).toEqual([0, 1]);
    }, 30_000);

  // The "all" nemesis (memory, seed 2): a mutation in flight when the connection was cut kept running on the
  // server; the client's resend failed on a store error, which the client was told as the mutation's failure
  // (DV-80: a store failure is a function error) — and the first attempt then committed. Convex treats a
  // store failure as a system error: the connection closes, the client resends again and gets the recorded
  // answer, so a mutation the app was told failed never takes effect.
  test.failing("a mutation reported failed never takes effect (a resend's store error)", async () => {
    const server = serverOn("memory", {
      JEPSEN_STORE_FAULTS: "1",
      JEPSEN_STORE_RATES: JSON.stringify({
        delay: 0,
        readError: 0,
        flushErrorBefore: 0,
        flushErrorAfter: 0,
        flushFatal: 0,
      }),
    });
    const proxy = new TcpProxy(await server.start());
    proxy.listen();
    cleanup.push(() => proxy.close());
    const c = client(proxy.port);
    await c.mutation("reg:write", { key: "k", value: 1 });

    await server.signal("SIGUSR2", "slow flushes on"); // the next commit takes 500 ms to become durable
    const outcome = c.mutation("reg:write", { key: "k", value: 2 }).then(
      () => "ok",
      (e: Error) => `failed: ${e.message.split("\n")[0]}`,
    );
    await Bun.sleep(100); // the first attempt is waiting for its flush
    await server.signal("SIGUSR1", "forced read errors on"); // the resend's lookup of its record fails
    proxy.dropAll();
    const told = await Promise.race([outcome, Bun.sleep(300).then(() => "pending")]);
    await server.signal("SIGUSR1", "forced read errors off");
    await server.signal("SIGUSR2", "slow flushes off");
    await outcome;
    await Bun.sleep(600);
    const value = await c.query("reg:read", { key: "k", nonce: 1 });
    // told it failed, the write must not be there; or else it must not have been told it failed
    expect({ told: told.startsWith("failed") ? "failed" : told, value }).not.toEqual({ told: "failed", value: 2 });
  }, 30_000);
});

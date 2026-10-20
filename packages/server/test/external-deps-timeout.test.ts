// A push's package install that never ends (STUDY-174 S6): Convex's `build_deps` request to its Node executor times
// out after NODE_ACTION_USER_TIMEOUT + 5 s (crates/local_backend/src/lib.rs:206, node_executor/src/local.rs:285), and
// the push fails with "Function execution unexpectedly timed out…" as an `InvalidExternalModules` error. Here a
// registry that accepts and never answers holds `bun install`: the install is killed at its deadline, and the push
// gets the same failure.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { buildExternalDeps, ExternalDepsError } from "../src/external-deps.ts";

const pending: (() => void)[] = [];
const registry = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  // Accepts every request and never answers it.
  fetch: () =>
    new Promise<Response>((resolve) => void pending.push(() => resolve(new Response(null, { status: 503 })))),
});
const cache = mkdtempSync(join(tmpdir(), "bunvex-deps-cache-"));
afterAll(() => {
  for (const answer of pending) answer();
  registry.stop(true);
  rmSync(cache, { recursive: true, force: true });
});

test("an install that hangs is killed at its deadline and fails as Convex's timed-out build", async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: "external-deps-timeout",
    instanceSecret: "12".repeat(32),
  }).init();
  const env = {
    ...process.env,
    BUN_CONFIG_REGISTRY: `http://127.0.0.1:${registry.port}/`,
    NPM_CONFIG_REGISTRY: `http://127.0.0.1:${registry.port}/`,
    BUN_INSTALL_CACHE_DIR: cache,
  };
  const t0 = performance.now();
  const outcome = await Promise.race([
    buildExternalDeps(engine, new MemoryBlobStore(), [{ name: "bunvex-s6-never-answered", version: "1.0.0" }], env, {
      timeoutMs: 1500,
    }).then(
      () => "installed",
      (e) => e,
    ),
    Bun.sleep(15_000).then(() => "still waiting after 15 s"),
  ]);
  expect(outcome).toBeInstanceOf(ExternalDepsError);
  expect((outcome as ExternalDepsError).message).toBe(
    "Function execution unexpectedly timed out. Check your function for infinite loops or other long-running operations.",
  );
  expect(performance.now() - t0).toBeLessThan(5000);
  expect(pending.length).toBeGreaterThan(0); // the install did reach the registry
  await engine.close();
}, 30_000);

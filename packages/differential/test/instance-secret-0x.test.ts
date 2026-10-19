// A `0x`-prefixed instance secret (STUDY-172 §7): Convex's `DeploymentSecret::try_from` decodes the secret with
// `const_hex::decode`, which drops one `0x` / `0X`, so each spelling is the same 32 bytes. Each backend runs (and
// its CLI deploys) under a prefixed spelling; every key issued by either binary under any spelling of that secret
// is accepted by both, and another secret's by neither. The refusals (`0x0x…`, `0x` alone) are compared in
// backend-flags.test.ts. Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBackendMain } from "bunvex/server";
import { type Backend, newStore, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`instance-secret-0x: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const HEX = "0123456789abcdef".repeat(4);
const SPELLINGS = [HEX, `0x${HEX}`, `0X${HEX}`, `0x${HEX.toUpperCase()}`];
const cwd = mkdtempSync(join(tmpdir(), "bunvex-secret-0x-"));
const stores: string[] = [];
afterAll(() => {
  for (const d of [cwd, ...stores]) rmSync(d, { recursive: true, force: true });
});

function convexKey(name: string, secret: string) {
  const r = Bun.spawnSync([ORACLE_BIN, "keygen", "admin-key", "--instance-name", name, "--instance-secret", secret], {
    cwd,
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  });
  if (r.exitCode !== 0) throw new Error(`Convex's keygen: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
async function bunvexKey(name: string, secret: string) {
  const out: string[] = [];
  const io = { env: {}, cwd, out: (l: string) => out.push(l), err: () => {} };
  const code = await localBackendMain(
    ["keygen", "admin-key", "--instance-name", name, "--instance-secret", secret],
    io,
    "v",
  );
  if (code !== 0) throw new Error(`bunvex's keygen exited ${code}`);
  return out[0]!;
}
const check = (b: Backend, key: string) =>
  fetch(`${b.url}/api/check_admin_key`, {
    headers: { authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${key}` },
  }).then((r) => r.status);

describe.skipIf(!ready)("a 0x-prefixed instance secret on Convex and on bunvex", () => {
  test("each backend starts and deploys under 0x; keys of every spelling, from either binary, work on both", async () => {
    const convexStore = { ...newStore(), secret: `0x${HEX}` };
    const bunvexStore = { ...newStore(), name: convexStore.name, secret: `0X${HEX.toUpperCase()}` };
    stores.push(convexStore.dir, bunvexStore.dir);
    const backends: Backend[] = [];
    try {
      // Each deploys with its CLI, under the key its own keygen issued for the prefixed spelling. One at a time, so
      // the first is stopped when the second fails to start.
      backends.push(await startConvex({ store: convexStore }));
      backends.push(await startBunvex({ store: bunvexStore }));
      const name = convexStore.name;
      const keys = [
        ...SPELLINGS.map((s) => convexKey(name, s)),
        ...(await Promise.all(SPELLINGS.map((s) => bunvexKey(name, s)))),
      ];
      const other = [convexKey(name, "cd".repeat(32)), await bunvexKey(name, "cd".repeat(32))];
      for (const b of backends) {
        for (const key of keys)
          expect({ backend: b.name, key, status: await check(b, key) }).toMatchObject({ status: 200 });
        for (const key of other)
          expect({ backend: b.name, key, status: await check(b, key) }).toMatchObject({ status: 401 });
      }
    } finally {
      for (const b of backends) await b.stop();
    }
  }, 180_000);
});

// `bunvex-local-backend` and BUNVEX_SQLITE_CACHE_SIZE (AD-46): read from the backend's own environment, and a value
// that does not parse stops the start before the store's file exists, as the other BUNVEX_* settings do.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBackendMain, parseLocalBackendFlags, startLocalBackend } from "../src/local-backend.ts";

const SECRET = "ab".repeat(32);
const dirs: string[] = [];
const stops: (() => unknown)[] = [];
const saved = process.env.BUNVEX_SQLITE_CACHE_SIZE;
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved === undefined) delete process.env.BUNVEX_SQLITE_CACHE_SIZE;
  else process.env.BUNVEX_SQLITE_CACHE_SIZE = saved;
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-sqlite-cache-"));
  dirs.push(d);
  return d;
};
const io = (cwd: string, env: Record<string, string> = {}) => {
  const err: string[] = [];
  return { err, it: { env, cwd, out: () => {}, err: (l: string) => err.push(l) } };
};
const flags = () => {
  const f = parseLocalBackendFlags(["--instance-secret", SECRET, "--port", "0", "--site-proxy-port", "0"]);
  if (typeof f === "string") throw new Error(f);
  return f;
};

describe("bunvex-local-backend with BUNVEX_SQLITE_CACHE_SIZE", () => {
  test("a value that does not parse stops the start, saying so, before the store's file exists", async () => {
    for (const bad of ["0", "256MiB", "-5"]) {
      const cwd = tempDir();
      const r = io(cwd, { BUNVEX_SQLITE_CACHE_SIZE: bad });
      expect(await localBackendMain(["--instance-secret", SECRET], r.it, "v1")).toBe(1);
      expect(r.err).toHaveLength(1);
      expect(r.err[0]).toStartWith(
        `Error: invalid value '${bad}' for the SQLite page cache (BUNVEX_SQLITE_CACHE_SIZE)`,
      );
      expect(existsSync(join(cwd, "bunvex_local_backend.sqlite3"))).toBe(false);
    }
  });

  test("the backend's environment is read, not the server process's", async () => {
    // The process's own value is bad; the backend's io says nothing (the default) or a good value: both start.
    process.env.BUNVEX_SQLITE_CACHE_SIZE = "nope";
    for (const env of [{}, { BUNVEX_SQLITE_CACHE_SIZE: "2048000" }] as Record<string, string>[]) {
      const b = await startLocalBackend(flags(), io(tempDir(), env).it);
      stops.push(b.stop);
      expect((await fetch(`${b.url}/instance_name`)).status).toBe(200);
    }
  });
});

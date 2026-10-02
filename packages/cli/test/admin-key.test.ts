// `bunvex admin-key` (STUDY-34, DV-160): a key that the running server accepts, read from its own store
// (no lease taken), or from INSTANCE_NAME / INSTANCE_SECRET / flags.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, checkAdminKey, createServer, Functions } from "@bunvex/server";
import { type Io, main } from "../src/index.ts";

const dirs: string[] = [];
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function io(env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const it: Io = { env, out: (l) => out.push(l), err: (l) => err.push(l) };
  return { it, out, err };
}

/** A server on a SQLite store in DATA, as `PERSISTENCE=sqlite DATA=…` opens it. */
async function serverOn(opts: { instanceName?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-cli-"));
  dirs.push(dir);
  const engine = await new Engine(
    defineSchema({}),
    new SqlitePersistence(join(dir, "bunvex.sqlite"), { durable: true }),
    opts,
  ).init();
  const server = createServer({ engine, functions: new Functions(engine), port: 0 });
  stops.push(() => server.shutdown());
  const check = async (key: string) => {
    const r = await fetch(`http://127.0.0.1:${server.server.port}/api/check_admin_key`, {
      headers: { authorization: `Bunvex ${key}` },
    });
    return { status: r.status, body: r.status === 200 ? await r.json() : null };
  };
  return { dir, engine, check };
}

describe("bunvex admin-key", () => {
  test("reads the running server's name and secret from its store; the key works", async () => {
    const s = await serverOn();
    const { it, out, err } = io({ PERSISTENCE: "sqlite", DATA: s.dir });
    expect(await main(["admin-key"], it)).toBe(0);
    expect(err).toEqual(["Admin key:"]);
    expect(out[0]).toStartWith("bunvex-self-hosted|01");
    expect(await s.check(out[0]!)).toEqual({ status: 200, body: { success: true, allowedOps: [], isReadOnly: false } });
  });

  test("--read-only and --system", async () => {
    const s = await serverOn({ instanceName: "shop" });
    const ro = io({ PERSISTENCE: "sqlite", DATA: s.dir });
    expect(await main(["admin-key", "--read-only"], ro.it)).toBe(0);
    expect(ro.err).toEqual(["Read-only admin key:"]);
    expect(ro.out[0]).toStartWith("shop|");
    expect((await s.check(ro.out[0]!)).body).toMatchObject({ isReadOnly: true });
    const sys = io({ PERSISTENCE: "sqlite", DATA: s.dir });
    expect(await main(["admin-key", "--system"], sys.it)).toBe(0);
    // A system key is not an admin for check_admin_key, but it is a valid key.
    expect((await s.check(sys.out[0]!)).status).toBe(403);
    const secret = (s.engine as unknown as { instanceSecret: string }).instanceSecret;
    expect(checkAdminKey(sys.out[0]!, "shop", adminKeyCipherKey(secret)).kind).toBe("system");
  });

  test("INSTANCE_NAME / INSTANCE_SECRET and the flags win over the store; no store needed", async () => {
    const secret = "ab".repeat(32);
    const env = io({ INSTANCE_NAME: "carnitas", INSTANCE_SECRET: secret, PERSISTENCE: "postgres" });
    expect(await main(["admin-key"], env.it)).toBe(0);
    expect(checkAdminKey(env.out[0]!, "carnitas", adminKeyCipherKey(secret)).kind).toBe("admin");
    const flags = io({});
    expect(await main(["admin-key", "--instance-name", "tacos", `--instance-secret=${secret}`], flags.it)).toBe(0);
    expect(checkAdminKey(flags.out[0]!, "tacos", adminKeyCipherKey(secret)).kind).toBe("admin");
  });

  test("errors: no secret anywhere, a bad option, a missing value, an unknown command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-cli-"));
    dirs.push(dir);
    const none = io({ PERSISTENCE: "sqlite", DATA: dir });
    expect(await main(["admin-key"], none.it)).toBe(1);
    expect(none.err[0]).toMatch(/no instance secret/);
    const bad = io({});
    expect(await main(["admin-key", "--nope"], bad.it)).toBe(2);
    expect(bad.err[0]).toMatch(/unknown option --nope/);
    const missing = io({});
    expect(await main(["admin-key", "--instance-name"], missing.it)).toBe(2);
    expect(missing.err[0]).toMatch(/--instance-name needs a value/);
    const both = io({});
    expect(await main(["admin-key", "--read-only", "--system"], both.it)).toBe(2);
    const unknown = io({});
    expect(await main(["deploy"], unknown.it)).toBe(2);
    expect(unknown.err[0]).toMatch(/unknown command deploy/);
    const help = io({});
    expect(await main(["admin-key", "--help"], help.it)).toBe(0);
    expect(help.out[0]).toMatch(/^Usage: bunvex admin-key/);
  });

  test("the bin runs it", async () => {
    const secret = "cd".repeat(32);
    const p = Bun.spawn(["bun", `${import.meta.dir}/../bin/bunvex.ts`, "admin-key"], {
      env: { ...process.env, INSTANCE_NAME: "bin", INSTANCE_SECRET: secret },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    expect([code, err.trim()]).toEqual([0, "Admin key:"]);
    expect(checkAdminKey(out.trim(), "bin", adminKeyCipherKey(secret)).kind).toBe("admin");
  });
});

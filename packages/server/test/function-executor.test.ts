// The executor seam and its knobs (STUDY-171, AD-44): every load of an app's modules goes through `loadCode`;
// `BUNVEX_FUNCTION_SANDBOX` / `--function-sandbox` and `BUNVEX_FUNCTION_SANDBOX_ISOLATION` checked strictly, the
// flag over the environment, and `process` (not built yet) refused at start rather than run as `vm`.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { CodeVersion } from "../src/code-version.ts";
import {
  functionSandbox,
  functionSandboxConfig,
  loadCode,
  PROCESS_SANDBOX_UNAVAILABLE,
  sandboxIsolation,
} from "../src/function-executor.ts";
import { Functions } from "../src/functions.ts";
import { localBackendMain, parseLocalBackendFlags, startLocalBackend } from "../src/local-backend.ts";
import { createServer } from "../src/server.ts";

const SECRET = "ab".repeat(32);
const dirs: string[] = [];
const stops: (() => unknown)[] = [];
const saved = {
  sandbox: process.env.BUNVEX_FUNCTION_SANDBOX,
  isolation: process.env.BUNVEX_FUNCTION_SANDBOX_ISOLATION,
};
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [name, value] of [
    ["BUNVEX_FUNCTION_SANDBOX", saved.sandbox],
    ["BUNVEX_FUNCTION_SANDBOX_ISOLATION", saved.isolation],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

describe("the knobs", () => {
  test("BUNVEX_FUNCTION_SANDBOX: vm by default, the two values, anything else an error naming them", () => {
    expect(functionSandbox(undefined)).toBe("vm");
    expect(functionSandbox("")).toBe("vm");
    expect(functionSandbox("vm")).toBe("vm");
    expect(functionSandbox("process")).toBe("process");
    for (const bad of ["VM", "isolate", " vm"])
      expect(() => functionSandbox(bad)).toThrow(
        `invalid value '${bad}' for the function sandbox (BUNVEX_FUNCTION_SANDBOX): possible values: vm, process`,
      );
  });

  test("BUNVEX_FUNCTION_SANDBOX_ISOLATION: auto by default, the four values, anything else an error", () => {
    expect(sandboxIsolation(undefined)).toBe("auto");
    expect(sandboxIsolation("")).toBe("auto");
    for (const v of ["auto", "namespaces", "landlock", "none"] as const) expect(sandboxIsolation(v)).toBe(v);
    expect(() => sandboxIsolation("bwrap")).toThrow(
      "invalid value 'bwrap' for the function sandbox's isolation (BUNVEX_FUNCTION_SANDBOX_ISOLATION): possible values: auto, namespaces, landlock, none",
    );
  });

  test("at start: vm runs; process is refused, not run as vm; a bad isolation is refused even with vm", () => {
    expect(functionSandboxConfig(undefined, undefined)).toEqual({ sandbox: "vm", isolation: "auto" });
    expect(functionSandboxConfig("vm", "none")).toEqual({ sandbox: "vm", isolation: "none" });
    for (const isolation of [undefined, "auto", "namespaces", "landlock", "none"])
      expect(() => functionSandboxConfig("process", isolation)).toThrow(PROCESS_SANDBOX_UNAVAILABLE);
    expect(PROCESS_SANDBOX_UNAVAILABLE).toContain("not available yet");
    expect(() => functionSandboxConfig("vm", "x")).toThrow("possible values: auto, namespaces, landlock, none");
  });
});

describe("createServer", () => {
  const engine = async () =>
    new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();

  test("refuses process from its option or the environment; the option wins over the environment", async () => {
    const e = await engine();
    stops.push(() => e.close());
    expect(() => createServer({ engine: e, functions: new Functions(e), port: 0, functionSandbox: "process" })).toThrow(
      PROCESS_SANDBOX_UNAVAILABLE,
    );
    process.env.BUNVEX_FUNCTION_SANDBOX = "process";
    expect(() => createServer({ engine: e, functions: new Functions(e), port: 0 })).toThrow(
      PROCESS_SANDBOX_UNAVAILABLE,
    );
    const app = createServer({ engine: e, functions: new Functions(e), port: 0, functionSandbox: "vm" });
    stops.unshift(() => app.shutdown());
    expect(app.server.port).toBeGreaterThan(0);
  });

  test("refuses a bad value in the environment", async () => {
    const e = await engine();
    stops.push(() => e.close());
    process.env.BUNVEX_FUNCTION_SANDBOX = "vm2";
    expect(() => createServer({ engine: e, functions: new Functions(e), port: 0 })).toThrow(
      "possible values: vm, process",
    );
    process.env.BUNVEX_FUNCTION_SANDBOX = "vm";
    process.env.BUNVEX_FUNCTION_SANDBOX_ISOLATION = "chroot";
    expect(() => createServer({ engine: e, functions: new Functions(e), port: 0 })).toThrow(
      "possible values: auto, namespaces, landlock, none",
    );
  });
});

describe("bunvex-local-backend", () => {
  const io = (cwd: string, env: Record<string, string> = {}) => {
    const err: string[] = [];
    return { err, it: { env, cwd, out: () => {}, err: (l: string) => err.push(l) } };
  };
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), "bunvex-sandbox-"));
    dirs.push(d);
    return d;
  };
  const flags = (...more: string[]) => {
    const f = parseLocalBackendFlags(["--instance-secret", SECRET, "--port", "0", "--site-proxy-port", "0", ...more]);
    if (typeof f === "string") throw new Error(f);
    return f;
  };

  test("--function-sandbox: the two values, checked as the other flags", () => {
    expect(flags().functionSandbox).toBeUndefined();
    expect(flags("--function-sandbox", "vm").functionSandbox).toBe("vm");
    expect(flags("--function-sandbox=process").functionSandbox).toBe("process");
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--function-sandbox", "jail"])).toBe(
      "error: invalid value 'jail' for '--function-sandbox <FUNCTION_SANDBOX>'\n  [possible values: vm, process]\n\nFor more information, try '--help'.",
    );
    expect(parseLocalBackendFlags(["--instance-secret", SECRET, "--function-sandbox"])).toBe(
      "error: a value is required for '--function-sandbox <FUNCTION_SANDBOX>' but none was supplied\n  [possible values: vm, process]\n\nFor more information, try '--help'.",
    );
  });

  test("process fails at start with the fix, before the store opens; from the flag or the environment", async () => {
    for (const [args, env] of [
      [["--function-sandbox", "process"], {}],
      [[], { BUNVEX_FUNCTION_SANDBOX: "process" }],
      // The flag wins over the environment.
      [["--function-sandbox", "process"], { BUNVEX_FUNCTION_SANDBOX: "vm" }],
    ] as const) {
      const cwd = tempDir();
      const r = io(cwd, env);
      expect(await localBackendMain(["--instance-secret", SECRET, ...args], r.it, "v1")).toBe(1);
      expect(r.err).toEqual([`Error: ${PROCESS_SANDBOX_UNAVAILABLE}`]);
      expect(existsSync(join(cwd, "bunvex_local_backend.sqlite3"))).toBe(false);
    }
  });

  test("--function-sandbox vm wins over BUNVEX_FUNCTION_SANDBOX=process; a bad isolation still fails", async () => {
    const cwd = tempDir();
    const b = await startLocalBackend(
      flags("--function-sandbox", "vm"),
      io(cwd, { BUNVEX_FUNCTION_SANDBOX: "process" }).it,
    );
    stops.push(b.stop);
    expect(await (await fetch(`${b.url}/instance_name`)).text()).toBe("bunvex-self-hosted");
    let failed: unknown;
    try {
      await startLocalBackend(flags(), io(tempDir(), { BUNVEX_FUNCTION_SANDBOX_ISOLATION: "full" }).it);
    } catch (e) {
      failed = e;
    }
    expect(String(failed)).toContain("invalid value 'full' for the function sandbox's isolation");
  });

  test("the local backend's choice reaches createServer, over the server process's environment", async () => {
    // The backend reads its `io.env`; the process's own variable must not refuse what the flag and io allowed.
    process.env.BUNVEX_FUNCTION_SANDBOX = "process";
    const b = await startLocalBackend(flags(), io(tempDir()).it);
    stops.push(b.stop);
    expect((await fetch(`${b.url}/instance_name`)).status).toBe(200);
  });
});

describe("loadCode", () => {
  test("loads as the vm executor: the same functions as CodeVersion.load", async () => {
    const sources = [
      {
        path: "m.js",
        environment: "isolate" as const,
        source: `import { query } from "@bunvex/server"; export const q = query(async () => 1);`,
      },
    ];
    const opts = { seed: new Uint32Array(4), timestamp: 0 };
    const [a, b] = [await loadCode(sources, opts), await CodeVersion.load(sources, opts)];
    expect(a).toBeInstanceOf(CodeVersion);
    expect([...a.functions.keys()]).toEqual([...b.functions.keys()]);
    expect(a.moduleHashes).toEqual(b.moduleHashes);
  });

  test("every load of app code in the server goes through it", () => {
    // A call site that loads `CodeVersion` itself would bypass the executor the start chose.
    const src = join(import.meta.dir, "../src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const bypass = files.filter(
      (f) => f !== "function-executor.ts" && /CodeVersion\.load\(/.test(readFileSync(join(src, f), "utf8")),
    );
    expect(bypass).toEqual([]);
    const callers = files.filter((f) => /\bloadCode\(/.test(readFileSync(join(src, f), "utf8"))).sort();
    expect(callers).toEqual(["code-store.ts", "push.ts", "server.ts", "test-function.ts"]);
  });
});

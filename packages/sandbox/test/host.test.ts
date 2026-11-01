// A sandboxed child's life on the host (STUDY-171 §7.3): the handshake, loads and evaluations, and every way a
// child goes wrong: it crashes, sends a message the host cannot use or one over the limit, or never says hello.
// Each failure kills the child and fails what waits on it with a `SandboxError` that says which.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FunctionExportError, InvalidModulesError, MissingEnvironmentVariableError } from "@bunvex/server/executor";
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, SandboxError, SandboxProcess } from "../src/index.ts";

const CHILDREN = join(import.meta.dir, "fixtures/children");
const fake = (name: string) => join(CHILDREN, `${name}.ts`);
const OPTS = { seed: new Uint32Array([1, 2, 3, 4]), timestamp: 1_760_000_000_000 };
const mod = (source: string, path = "m.js") => ({ path, source, environment: "isolate" as const });
const QUERY = mod(`import { query } from "@bunvex/server"; export const q = query(async () => 1);`);

const started: SandboxProcess[] = [];
async function start(...args: Parameters<typeof SandboxProcess.start>) {
  const c = await SandboxProcess.start(...args);
  started.push(c);
  return c;
}
afterEach(async () => {
  for (const c of started.splice(0)) await c.close();
});

/** Whether the process with this pid is gone. */
function gone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** The error a promise rejects with (awaited here, not through `expect(...).rejects`). */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("it did not reject");
}

describe("a child", () => {
  test("says hello, loads and analyzes a version, and stops", async () => {
    const c = await start();
    expect(c.spawnToReadyMs).toBeGreaterThan(0);
    const v = await c.load([QUERY], OPTS);
    expect([...v.functions]).toEqual([
      ["m:q", { kind: "query", visibility: "public", node: false, args: null, returns: null }],
    ]);
    expect(v.analysis["m.js"]!.functions.map((f) => f.name)).toEqual(["q"]);
    expect(v.moduleHashes.get("m")).toMatch(/^[0-9a-f]{64}$/);
    expect(v.loadMs).toBeGreaterThan(0);
    const pid = c.pid;
    await c.close();
    expect(c.failure?.reason).toBe("stopped");
    expect(gone(pid)).toBe(true);
    const after = await rejection(c.load([QUERY], OPTS));
    expect(after).toBeInstanceOf(SandboxError);
    expect(after.message).toBe("the function sandbox's process was stopped");
  });

  test("runs requests concurrently, each answered by its own id", async () => {
    const c = await start();
    const sources = ["a", "b", "c", "d"].map((n) =>
      mod(`import { mutation } from "@bunvex/server"; export const ${n} = mutation(async () => 1);`, `${n}.js`),
    );
    const loads = await Promise.all(sources.map((s) => c.load([s], OPTS)));
    expect(loads.map((v) => [...v.functions.keys()])).toEqual([["a:a"], ["b:b"], ["c:c"], ["d:d"]]);
  });

  test("a load's errors are the in-process loader's classes and words", async () => {
    const c = await start();
    const invalid = await rejection(c.load([mod("throw new Error('boom');")], OPTS));
    expect(invalid).toBeInstanceOf(InvalidModulesError);
    expect((invalid as InvalidModulesError).detail).toBe(
      "Failed to analyze m.js: Uncaught Error: boom\n    at m.js:1:7",
    );
    const exportError = await rejection(
      c.load(
        [
          mod(
            `import { query } from "@bunvex/server"; const f = query(async () => 1); f.exportArgs = () => { throw new Error("no"); }; export { f };`,
          ),
        ],
        OPTS,
      ),
    );
    expect(exportError).toBeInstanceOf(FunctionExportError);
    const missing = await rejection(
      c.evaluate(
        mod("export default { providers: [{ domain: process.env.ISSUER, applicationID: 'app' }] };", "auth.config.js"),
        { ...OPTS, env: {}, failOnMissingEnv: true },
        "authConfig",
      ),
    );
    expect(missing).toBeInstanceOf(MissingEnvironmentVariableError);
    expect((missing as MissingEnvironmentVariableError).variable).toBe("ISSUER");
    // The child is fine after its loads fail.
    expect((await c.load([QUERY], OPTS)).functions.size).toBe(1);
    expect(c.failure).toBeNull();
  });

  test("the deployment's variables reach the import phase, as in-process", async () => {
    const c = await start();
    const flagged = mod(
      `import { query } from "@bunvex/server"; if (process.env.FLAG !== "on") throw new Error("FLAG is " + process.env.FLAG); export const q = query(async () => 1);`,
    );
    expect([...(await c.load([flagged], { ...OPTS, env: { FLAG: "on" } })).functions.keys()]).toEqual(["m:q"]);
    const e = await rejection(c.load([flagged], { ...OPTS, env: {} }));
    expect((e as InvalidModulesError).detail).toStartWith("Failed to analyze m.js: Uncaught Error: FLAG is undefined");
  });

  test("its environment holds only the loader's knobs and TZ (UTC), never the server's variables", async () => {
    process.env.SANDBOX_TEST_SECRET = "s3cret";
    process.env.MAX_USER_MODULES = "4096";
    try {
      const c = await start({ entry: fake("env") });
      const e = await rejection(c.load([QUERY], OPTS));
      expect(JSON.parse(e.message)).toEqual(["MAX_USER_MODULES", "TZ"]);
    } finally {
      delete process.env.SANDBOX_TEST_SECRET;
      delete process.env.MAX_USER_MODULES;
    }
  });
});

describe("a child that goes wrong is killed, and what waits on it fails with why", () => {
  test("it never says hello: the handshake times out", async () => {
    const t = performance.now();
    const e = await rejection(SandboxProcess.start({ entry: fake("silent"), handshakeTimeoutMs: 300 }));
    expect(e).toBeInstanceOf(SandboxError);
    expect((e as SandboxError).reason).toBe("handshakeTimeout");
    expect(e.message).toBe("the function sandbox's process did not start within 300 ms");
    expect(performance.now() - t).toBeLessThan(5000);
  });

  test("it speaks another protocol", async () => {
    const e = await rejection(SandboxProcess.start({ entry: fake("wrong-protocol") }));
    expect((e as SandboxError).reason).toBe("protocol");
    expect(e.message).toBe(`the function sandbox's process speaks protocol 999, not ${PROTOCOL_VERSION}`);
  });

  test("it dies during a request: a crash, with its stderr", async () => {
    const c = await start({ entry: fake("crash") });
    const e = await rejection(c.load([QUERY], OPTS));
    expect((e as SandboxError).reason).toBe("crash");
    expect(e.message).toBe("the function sandbox's process exited unexpectedly (exit code 3): the child fell over");
    // Later requests fail with the same error, without waiting.
    expect(await rejection(c.load([QUERY], OPTS))).toBe(e);
  });

  test("its socket breaks before it exits: a crash, never a bad message", async () => {
    // On Linux a child that exits with frames of the host's unread resets the socket, and the host's read can fail
    // before the host sees the exit (CI run 39367529452). This child holds the reset apart from its exit.
    const c = await start({ entry: fake("reset") });
    const e = await rejection(c.load([QUERY], OPTS));
    expect((e as SandboxError).reason).toBe("crash");
    // Left alive behind the broken socket, it is killed.
    expect(e.message).toBe(
      "the function sandbox's process exited unexpectedly (signal SIGKILL): the child dropped its channel",
    );
    expect(gone(c.pid)).toBe(true);
  });

  test("the real child, killed in the middle of a load", async () => {
    const c = await start();
    const spin = mod("while (true) {}");
    const load = c.load([spin], { ...OPTS, importTimeoutMs: 20_000 });
    const other = c.load([QUERY], OPTS);
    await Bun.sleep(100);
    process.kill(c.pid, "SIGKILL");
    const [a, b] = [await rejection(load), await rejection(other)];
    expect((a as SandboxError).reason).toBe("crash");
    expect(a.message).toBe("the function sandbox's process exited unexpectedly (signal SIGKILL)");
    expect(b).toBe(a);
  });

  test("it sends a frame that is not JSON", async () => {
    const c = await start({ entry: fake("not-json") });
    const e = await rejection(c.load([QUERY], OPTS));
    expect((e as SandboxError).reason).toBe("badMessage");
    expect(e.message).toStartWith("the function sandbox's process sent a message that is not valid: not JSON (");
    await Bun.sleep(50);
    expect(gone(c.pid)).toBe(true);
  });

  test("it sends a message of the wrong shape", async () => {
    const c = await start({ entry: fake("bad-shape") });
    const e = await rejection(c.load([QUERY], OPTS));
    expect((e as SandboxError).reason).toBe("badMessage");
    expect(e.message).toBe(
      "the function sandbox's process sent a message that is not valid: loaded.version.analysis: expected an array",
    );
  });

  test("it answers a request that was never made", async () => {
    const c = await start({ entry: fake("stray-answer") });
    const e = await rejection(c.load([QUERY], OPTS));
    expect(e.message).toBe(
      "the function sandbox's process sent a message that is not valid: an answer to no request (failed 1001)",
    );
  });

  test("it sends a message over the limit: refused from its header, before its body", async () => {
    const c = await start({ entry: fake("oversize") });
    const t = performance.now();
    const e = await rejection(c.load([QUERY], OPTS));
    expect((e as SandboxError).reason).toBe("oversize");
    expect(e.message).toBe(
      `the function sandbox's process sent a message of ${200 * 1024 * 1024} bytes, over the limit of ${MAX_MESSAGE_BYTES} bytes`,
    );
    // The body never came: the header alone failed it.
    expect(performance.now() - t).toBeLessThan(5000);
  });

  test("the limit holds for the real child's answers too", async () => {
    const c = await start({ maxMessageBytes: 1000 });
    const names = Array.from({ length: 50 }, (_, i) => `export const f${i} = query(async () => ${i});`).join("\n");
    const e = await rejection(c.load([mod(`import { query } from "@bunvex/server";\n${names}`)], OPTS));
    expect((e as SandboxError).reason).toBe("oversize");
    expect(e.message).toMatch(
      /^the function sandbox's process sent a message of \d+ bytes, over the limit of 1000 bytes$/,
    );
  });

  test("the host breaks the stream: the child exits, saying why", async () => {
    const c = await start();
    // Not a frame of JSON: the child cannot trust what follows, and stops.
    const sink = (c as unknown as { sink: { write(b: Uint8Array): void; flush(): unknown } }).sink;
    sink.write(new Uint8Array([3, 0, 0, 0, 0x7b, 0x7b, 0x7b]));
    await sink.flush();
    const e = await rejection(c.load([QUERY], OPTS));
    expect((e as SandboxError).reason).toBe("crash");
    expect(e.message).toBe(
      "the function sandbox's process exited unexpectedly (exit code 70): bunvex sandbox: a message that is not JSON",
    );
  });
});

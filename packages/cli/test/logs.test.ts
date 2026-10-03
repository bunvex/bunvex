// `bunvex logs` end to end (STUDY-47 PR 2), as `npx convex logs`: tailing from the head, `--history [n]`,
// `--success`, `--jsonl`, Convex's line format, a 403 ending it; and the line formatting on its own.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { action, adminKeyCipherKey, createServer, Functions, issueAdminKey, mutation, query } from "@bunvex/server";
import type { Io } from "../src/io.ts";
import { COLORS, formatEntries, type LogEntry, LogManager, logsCommand, NO_COLORS } from "../src/logs.ts";

const SECRET = "7b".repeat(32);
const NAME = "cli-logs";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: NAME,
    instanceSecret: SECRET,
  }).init();
  const functions = new Functions(engine).register("m", {
    hello: query((_ctx, { n }: { n: number }) => {
      console.log("hello", n);
      return n;
    }),
    fails: mutation(() => {
      throw new Error("nope");
    }),
    work: action(() => {
      console.warn("working");
    }),
  });
  const s = createServer({ engine, functions, port: 0, exportStorage: null });
  stops.push(() => s.shutdown());
  const dir = mkdtempSync(join(tmpdir(), "bunvex-cli-logs-"));
  dirs.push(dir);
  const api = `http://127.0.0.1:${s.server.port}`;
  const call = (kind: string, path: string, args: object = {}) =>
    fetch(`${api}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args }),
    }).then((r) => r.json());
  /** Run `bunvex logs` until `until` holds of its output (then abort it). */
  const run = async (args: string[], until: (out: string[]) => boolean, key = KEY) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      env: { BUNVEX_SELF_HOSTED_URL: api, BUNVEX_SELF_HOSTED_ADMIN_KEY: key },
      cwd: dir,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    };
    const stop = new AbortController();
    const code = logsCommand(args, io, { signal: stop.signal });
    for (let i = 0; i < 300 && !until(out); i++) await Bun.sleep(10);
    stop.abort();
    return { code: await code, out, err };
  };
  return { run, call };
}

const LINE = /^.+? \[BUNVEX ([QMAH])\((.+?)\)\] (.*)$/s;

test("tails from the head: what ran before is not printed, what runs after is", async () => {
  const { run, call } = await setup();
  await call("query", "m:hello", { n: 1 });
  const done = run([], (out) => out.length >= 3);
  await Bun.sleep(100);
  await call("query", "m:hello", { n: 2 });
  await call("mutation", "m:fails");
  await call("action", "m:work");
  const { code, out, err } = await done;
  expect(code).toBe(0);
  expect(err[0]).toBe("Watching logs for dev deployment...");
  expect(out.map((l) => LINE.exec(l)!.slice(1))).toEqual([
    ["Q", "m:hello", "[LOG] 'hello' 2"],
    ["M", "m:fails", expect.stringMatching(/^Uncaught Error: nope\n/)],
    ["A", "m:work", "[WARN] 'working'"],
  ]);
});

test("--history [n] prints what the server kept first; --success a line per success; --jsonl the raw entries", async () => {
  const { run, call } = await setup();
  for (const n of [1, 2, 3]) await call("query", "m:hello", { n });
  const all = await run(["--history"], (out) => out.length >= 3);
  expect(all.out.map((l) => LINE.exec(l)![3])).toEqual(["[LOG] 'hello' 1", "[LOG] 'hello' 2", "[LOG] 'hello' 3"]);
  const last = await run(["--history", "1", "--success"], (out) => out.length >= 2);
  expect(last.out.map((l) => LINE.exec(l)![3])).toEqual([
    "[LOG] 'hello' 3",
    expect.stringMatching(/^Function executed in \d+ ms$/),
  ]);
  const jsonl = await run(["--history=2", "--jsonl"], (out) => out.length >= 2);
  const entries = jsonl.out.map((l) => JSON.parse(l));
  expect(entries.map((e) => [e.kind, e.identifier])).toEqual([
    ["Completion", "m:hello"],
    ["Completion", "m:hello"],
  ]);
  // The CLI's client header gets structured lines.
  expect(entries[0].logLines[0]).toMatchObject({ messages: ["'hello'", "2"], level: "LOG", isTruncated: false });
});

test("a 403 ends it with the error (other failures retry); bad options are usage errors", async () => {
  const { run } = await setup();
  const forbidden = Bun.serve({
    port: 0,
    fetch: () => Response.json({ code: "OperationNotPermitted", message: "not allowed to view logs" }, { status: 403 }),
  });
  stops.push(() => forbidden.stop(true));
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env: { BUNVEX_SELF_HOSTED_URL: `http://127.0.0.1:${forbidden.port}`, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY },
    cwd: tmpdir(),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  expect(await logsCommand([], io, { signal: new AbortController().signal })).toBe(1);
  expect(err.at(-1)).toBe("bunvex logs: not allowed to view logs");
  expect((await run(["--history", "x"], () => true)).code).toBe(2);
  expect((await run(["--nope"], () => true)).code).toBe(2);
});

test("Convex's line format: string lines, structured lines, errors, colors", () => {
  const at = Date.UTC(2026, 0, 2, 3, 4, 5) / 1000;
  const local = new Date(at * 1000).toLocaleString();
  const entries: LogEntry[] = [
    {
      kind: "Completion",
      udfType: "Query",
      identifier: "m:q",
      timestamp: at,
      logLines: ["[INFO] 'x' 1"],
      executionTime: 0.0012,
    },
    {
      kind: "Progress",
      udfType: "HttpAction",
      identifier: "GET /p",
      timestamp: at,
      logLines: [{ messages: ["a", "b"], level: "DEBUG", timestamp: at * 1000, isTruncated: true }],
    },
    { kind: "Completion", udfType: "Mutation", identifier: "m:m", timestamp: at, logLines: [], error: "boom" },
    { kind: "Completion", udfType: "Action", identifier: "m:a", timestamp: at, logLines: ["no level"] },
  ];
  expect(formatEntries(entries, { success: true, colors: NO_COLORS })).toEqual([
    `${local} [BUNVEX Q(m:q)] [INFO] 'x' 1`,
    `${local} [BUNVEX Q(m:q)] Function executed in 2 ms`,
    `${local} [BUNVEX H(GET /p)] [DEBUG] a b (truncated due to length)`,
    `${local} [BUNVEX M(m:m)] boom`,
    "[BUNVEX A(m:a)] Could not parse console.log",
    `${local} [BUNVEX A(m:a)] Function executed in NaN ms`,
  ]);
  const [colored] = formatEntries(entries.slice(0, 1), { success: false, colors: COLORS });
  expect(colored).toBe(`\x1b[36m${local} [BUNVEX Q(m:q)] [INFO]\x1b[39m 'x' 1`);
});

test("pause-on-deploy holds output during a push; always does not", async () => {
  const paused = new LogManager("pause-on-deploy");
  paused.beginDeploy();
  let released = false;
  const waiting = paused.waitForUnpaused().then(() => (released = true));
  await Bun.sleep(150);
  expect(released).toBe(false);
  paused.endDeploy();
  await waiting;
  const always = new LogManager("always");
  always.beginDeploy();
  await always.waitForUnpaused();
});

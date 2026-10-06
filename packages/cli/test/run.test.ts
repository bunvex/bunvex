// `bunvex run` end to end (STUDY-37 PR 3) against a running deployable server, and `POST /api/function`:
// any kind, internal ones for an admin, JSON5 arguments, `--identity`, log lines on stderr, the result on
// stdout, Convex's errors and the list of available functions, `--push`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { type Io, main } from "../src/index.ts";
import { parseJson5 } from "../src/json5.ts";
import { fakeIdentity, parseFunctionName, runCommand } from "../src/run.ts";
import { memoryStore } from "./memory-store.ts";

const SECRET = "12".repeat(32);
const NAME = "run-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const SERVER = ["bunvex", "server"].join("/");

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-run-"));
  dirs.push(d);
  return d;
};

const MODULE = `import { action, internalMutation, mutation, query } from ${JSON.stringify(SERVER)};
export const list = query(async ({ db }) => (await db.query("items").collect()).map((d) => d.n));
export const add = mutation(async ({ db }, { n }) => { console.log("adding", n); await db.insert("items", { n }); });
export const echo = action(async (_, args) => args);
export const secret = internalMutation(async () => "internal ok");
export const whoami = query(async ({ auth }) => auth.getUserIdentity());
export default query(async () => "default export");`;

async function deployment() {
  const engine = await new Engine(
    defineSchema({}),
    new SqlitePersistence(join(tmp(), "db.sqlite"), { durable: true }),
    {
      instanceName: NAME,
      instanceSecret: SECRET,
      storedSchema: true,
    },
  ).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    moduleStorage: memoryStore() as never,
    redactLogsToClient: false,
  });
  stops.push(() => s.shutdown());
  await s.deployCode([{ path: "items.js", source: MODULE, environment: "isolate" }]);
  return `http://127.0.0.1:${s.server.port}`;
}

async function run(cwd: string, url: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const it: Io = {
    env: { BUNVEX_SELF_HOSTED_URL: url, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY },
    cwd,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { code: await main(["run", ...args], it), out, err };
}

describe("bunvex run", () => {
  test("queries, mutations, actions and internal functions; JSON5 args; logs on stderr, results on stdout", async () => {
    const url = await deployment();
    const dir = tmp();
    expect(await run(dir, url, "items:add", "{ n: 1, }")).toEqual({
      code: 0,
      out: [], // a null result prints nothing
      err: ["[BUNVEX ?(items:add)] [LOG] 'adding' 1"],
    });
    await run(dir, url, "api.items.add", "{n: 2}");
    expect((await run(dir, url, "items:list")).out).toEqual(["[\n  1,\n  2\n]"]);
    expect((await run(dir, url, "items:echo", "{ big: {$integer: 'AQAAAAAAAAA='}, 'q': 'x' }")).out).toEqual([
      JSON.stringify({ big: { $integer: "AQAAAAAAAAA=" }, q: "x" }, null, 2),
    ]);
    expect((await run(dir, url, "internal.items.secret")).out).toEqual(['"internal ok"']);
    expect((await run(dir, url, "items")).out).toEqual(['"default export"']);
    expect((await run(dir, url, "bunvex/items.ts")).out).toEqual(['"default export"']);
  });

  test("--identity acts as a user, with Convex's defaults", async () => {
    const url = await deployment();
    const r = await run(tmp(), url, "items:whoami", "{}", "--identity", "{ name: 'Ada' }");
    const who = JSON.parse(r.out[0]!);
    expect(who).toMatchObject({ name: "Ada", issuer: "https://bunvex.test" });
    expect(who.tokenIdentifier).toBe(`https://bunvex.test|${who.subject}`);
    expect(fakeIdentity("{ subject: 'u1' }")).toEqual({
      subject: "u1",
      issuer: "https://bunvex.test",
      tokenIdentifier: "https://bunvex.test|u1",
    });
  });

  test("errors: a missing function lists the deployment's; bad arguments; exit codes", async () => {
    const url = await deployment();
    const dir = tmp();
    const missing = await run(dir, url, "items:nope");
    expect(missing.code).toBe(1);
    const text = missing.err.join("\n");
    expect(text).toStartWith('Failed to run function "items:nope":\n[Request ID: ');
    expect(text).toContain(
      "Could not find function for 'items:nope'. Did you forget to run `bunvex dev`?\n\nAvailable functions:\n",
    );
    expect(text.split("Available functions:\n")[1]!.split("\n").sort()).toEqual([
      "• items:add",
      "• items:default",
      "• items:echo",
      "• items:list",
      "• items:secret",
      "• items:whoami",
    ]);
    const thrown = await run(dir, url, "items:add", "{ n: 'x' }");
    expect(thrown.code).toBe(0); // it inserts a string; no validator
    const badArgs = await run(dir, url, "items:add", "{ n: ");
    expect(badArgs.code).toBe(1);
    expect(badArgs.err[0]).toStartWith('Failed to parse arguments as JSON: "{ n: "');
    expect((await run(dir, url, "api.items")).err).toEqual(['Function name has too few parts: "api.items"']);
    // No function: Convex's message (STUDY-119), exit 1.
    expect(await run(dir, url)).toMatchObject({
      code: 1,
      err: ["`bunvex run` requires either <functionName> or `--inline-query`."],
    });
    const many = await run(dir, url, "a:b", "{}", "extra");
    expect([many.code, many.err[0]]).toEqual([
      1,
      "error: too many arguments for 'run'. Expected 2 arguments but got 3.",
    ]);
  });

  test("--watch: the result, then each change, until stopped; a missing function fails", async () => {
    const url = await deployment();
    const dir = tmp();
    const out: string[] = [];
    const err: string[] = [];
    const it: Io = {
      env: { BUNVEX_SELF_HOSTED_URL: url, BUNVEX_SELF_HOSTED_ADMIN_KEY: KEY },
      cwd: dir,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    };
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 200 && !pred(); i++) await Bun.sleep(25);
      expect(pred()).toBe(true);
    };
    const stop = new AbortController();
    const watching = runCommand(["items:list", "--watch"], it, { signal: stop.signal });
    await until(() => out.length === 1);
    expect(err[0]).toBe(`✔ Watching query items:list on ${url}...`);
    expect(out).toEqual(["[]"]);
    await run(dir, url, "items:add", "{ n: 5 }");
    await until(() => out.length === 2);
    expect(out[1]).toBe("[\n  5\n]");
    stop.abort();
    expect(await watching).toBe(0);
    expect(err.at(-1)).toBe(`Closing connection to ${url}...`);
    // Acting as a user, over the socket too.
    const who: string[] = [];
    const stop2 = new AbortController();
    const asAda = runCommand(
      ["items:whoami", "{}", "--watch", "--identity", "{ name: 'Ada' }"],
      { ...it, out: (l) => who.push(l) },
      { signal: stop2.signal },
    );
    await until(() => who.length === 1);
    expect(JSON.parse(who[0]!)).toMatchObject({ name: "Ada", issuer: "https://bunvex.test" });
    stop2.abort();
    await asAda;
    const missing: string[] = [];
    const code = await runCommand(["items:nope", "--watch"], { ...it, err: (l) => missing.push(l) });
    expect(code).toBe(1);
    expect(missing.at(-1)).toContain('Failed to run function "items:nope":');
  });

  test("--push deploys the functions directory first", async () => {
    const url = await deployment();
    const dir = tmp();
    mkdirSync(join(dir, "bunvex"));
    writeFileSync(
      join(dir, "bunvex/hello.ts"),
      `import { query } from ${JSON.stringify(SERVER)};\nexport const hi = query(async () => "pushed");`,
    );
    const r = await run(dir, url, "hello:hi", "--push", "--typecheck=disable");
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toBe('"pushed"');
  });

  test("POST /api/function without an admin key: 403 BadDeployKey, as Convex's `must_be_admin` (STUDY-67 H5)", async () => {
    const url = await deployment();
    const r = await fetch(`${url}/api/function`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "items:list", args: {} }),
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code: string }).code).toBe("BadDeployKey");
  });
});

describe("names and JSON5", () => {
  test("Convex's function name forms", () => {
    const dir = tmp();
    mkdirSync(join(dir, "bunvex/bunvex"), { recursive: true });
    writeFileSync(join(dir, "bunvex/bunvex/inner.ts"), "export const x = 1;");
    const p = (n: string) => parseFunctionName(n, dir, join(dir, "bunvex"));
    expect(p("api.dir.file.fn")).toBe("dir/file:fn");
    expect(p("internal.a.b")).toBe("a:b");
    expect(p("a/b")).toBe("a/b:default");
    expect(p("a/b.ts:c")).toBe("a/b:c");
    expect(p("bunvex/a/b:c")).toBe("a/b:c");
    expect(p("bunvex/inner:x")).toBe("bunvex/inner:x"); // a file of that name exists under the directory
  });

  test("Convex's parseFunctionName cases, with bunvex's directory (cli/lib/run.test.ts; G-L7)", () => {
    const dir = tmp();
    for (const f of ["bunvex/foo/bar.ts", "bunvex/bunvex/bar/baz.ts", "src/bunvex/foo/bar.ts"]) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), "export default 1;");
    }
    const p = (n: string, functionsDir = "bunvex/") => parseFunctionName(n, dir, join(dir, functionsDir));
    expect(p("api.foo.bar")).toBe("foo:bar");
    expect(p("internal.foo.bar")).toBe("foo:bar");
    expect(p("foo/bar")).toBe("foo/bar:default");
    expect(p("foo/bar:baz")).toBe("foo/bar:baz");
    expect(p("bunvex/foo/bar")).toBe("foo/bar:default");
    expect(p("bunvex/foo/bar.ts")).toBe("foo/bar:default");
    expect(p("bunvex/foo/bar.ts:baz")).toBe("foo/bar:baz");
    // A file `bunvex/bar/baz.ts` under the functions directory: the prefix is the module's.
    expect(p("bunvex/bar/baz")).toBe("bunvex/bar/baz:default");
    // A nested functions directory.
    expect(p("src/bunvex/foo/bar", "src/bunvex/")).toBe("foo/bar:default");
    expect(p("foo/bar", "src/bunvex/")).toBe("foo/bar:default");
  });

  test("the JSON5 reader", () => {
    expect(
      parseJson5(`{
        // a comment
        unquoted: 'single', "double": "x\\ny", trailing: [1, 2,], hex: 0x1F, half: .5, plus: +1, /* block */
        inf: -Infinity, ok: true, none: null,
      }`),
    ).toEqual({
      unquoted: "single",
      double: "x\ny",
      trailing: [1, 2],
      hex: 31,
      half: 0.5,
      plus: 1,
      inf: -Infinity,
      ok: true,
      none: null,
    });
    expect(Number.isNaN(parseJson5("NaN"))).toBe(true);
    expect(() => parseJson5("{ a: }")).toThrow(/JSON5: invalid character '}' at 1:6/);
    expect(() => parseJson5("[1, 2")).toThrow(/invalid end of input/);
    expect(() => parseJson5("{} x")).toThrow(/invalid character 'x'/);
  });
});

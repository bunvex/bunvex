// `bunvex run --inline-query` (STUDY-119) end to end against a running deployable server: Convex's wrapping
// rules (checked against the official `convex` package's own `inlineQueryToQuerySource`), log lines on
// stderr and the value on stdout, `Query failed`, Convex's refusals, `--push`, `--no-push`, components.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import fc from "fast-check";
import { type Io, main } from "../src/index.ts";
import { inlineQuerySource } from "../src/inline-query.ts";
import { memoryStore } from "./memory-store.ts";

const SECRET = "34".repeat(32);
const NAME = "inline-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const SERVER = ["bunvex", "server"].join("/");

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-inline-"));
  dirs.push(d);
  return d;
};

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
  await s.deployCode([
    {
      path: "items.js",
      source: `import { mutation } from ${JSON.stringify(SERVER)};
export const add = mutation(async ({ db }, { n }) => { await db.insert("items", { n }); });`,
      environment: "isolate",
    },
  ]);
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

/**
 * The official package's `inlineQueryToQuerySource` (cli/lib/runTestFunction.js), loaded without its one
 * import (`deploymentFetch`, whose dependencies the package leaves to its bundle).
 */
async function convexWrapper(): Promise<(q: string) => string> {
  const pkg = Bun.resolveSync("convex/package.json", join(import.meta.dir, "../../sync-e2e"));
  const text = readFileSync(join(dirname(pkg), "dist/esm/cli/lib/runTestFunction.js"), "utf8");
  const file = join(tmp(), "runTestFunction.mjs");
  writeFileSync(file, text.replace(/^import .*;$/m, ""));
  const fn = (await import(file)).inlineQueryToQuerySource as (q: string) => string;
  // Its wrappers' specifier, in bunvex's name (DV-390).
  const theirs = ["con", "vex:/"].join("");
  return (q) => fn(q.replaceAll("bunvex:/", theirs)).replaceAll(theirs, "bunvex:/");
}

describe("the inline query's module, as Convex's", () => {
  test("an expression is returned; statements kept; a module gets the import; the oracle agrees", async () => {
    expect(inlineQuerySource(' await ctx.db.query("items").take(5); ')).toBe(
      [
        'import { query, internalQuery } from "bunvex:/_system/repl/wrappers.js";',
        "",
        "export default query({",
        "  handler: async (ctx) => {",
        '    return (await ctx.db.query("items").take(5));',
        "  },",
        "});",
      ].join("\n"),
    );
    const oracle = await convexWrapper();
    const cases = [
      'await ctx.db.query("items").take(5)',
      "1 + 1;",
      "const x = 1; return x;",
      "return 5",
      "if (true) return 1",
      "letter",
      "constant + 1",
      "a\nb",
      "const a = 1;\nreturn a;",
      "export default query({ handler: async () => 1 })",
      "export default internalQuery ({ handler: async () => 1 })",
      'import { query } from "bunvex:/_system/repl/wrappers.js";\nexport default query({ handler: async () => 1 })',
      "export default 1",
      "query(1)",
      "  spaced  ",
      "x;;",
    ];
    for (const c of cases) expect(inlineQuerySource(c)).toBe(oracle(c));
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            "export default ",
            "query(",
            "internalQuery (",
            "return ",
            "const ",
            "\n",
            ";",
            " ",
            "x",
            "1",
          ),
          { maxLength: 8 },
        ),
        (parts) => {
          const q = parts.join("");
          expect(inlineQuerySource(q)).toBe(oracle(q));
        },
      ),
    );
  });
});

describe("bunvex run --inline-query", () => {
  test("the value on stdout, the log lines on stderr; null prints nothing", async () => {
    const url = await deployment();
    const dir = tmp();
    await run(dir, url, "items:add", "{ n: 1 }");
    await run(dir, url, "items:add", "{ n: 2 }");
    expect(await run(dir, url, "--inline-query", '(await ctx.db.query("items").collect()).map((d) => d.n)')).toEqual({
      code: 0,
      out: ["[\n  1,\n  2\n]"],
      err: [],
    });
    expect(
      await run(
        dir,
        url,
        "--inline-query=const docs = await ctx.db.query('items').collect(); console.log('n', docs.length); return null;",
      ),
    ).toEqual({ code: 0, out: [], err: ["[LOG] 'n' 2"] });
    // A whole module, as written.
    const mod = await run(dir, url, "--inline-query", "export default query({ handler: async () => ({ a: 1n }) })");
    expect(mod.out).toEqual([JSON.stringify({ a: { $integer: "AQAAAAAAAAA=" } }, null, 2)]);
  });

  test("a failed run: `Query failed: <response>`, exit 1; a refused module: the request's error", async () => {
    const url = await deployment();
    const dir = tmp();
    const failed = await run(dir, url, "--inline-query", 'console.log("x");\nthrow new Error("nope");');
    expect(failed.code).toBe(1);
    expect(failed.out).toEqual([]);
    expect(failed.err).toHaveLength(1);
    expect(failed.err[0]).toStartWith('Query failed: {\n  "status": "error",\n  "errorMessage": ');
    const payload = JSON.parse(failed.err[0]!.slice("Query failed: ".length));
    expect(payload.errorMessage).toContain("Uncaught Error: nope");
    expect(payload.logLines).toEqual(["[LOG] 'x'"]);
    // A write is refused: queries are readonly.
    const write = await run(dir, url, "--inline-query", 'await ctx.db.insert("items", { n: 3 })');
    expect(write.code).toBe(1);
    expect(write.err[0]).toContain("queries cannot write");
    // A module with another export: Convex's fetch error, as it prints it.
    const other = await run(
      dir,
      url,
      "--inline-query",
      "export const a = query({ handler: async () => 1 }); export default query({ handler: async () => 2 })",
    );
    expect(other).toEqual({
      code: 1,
      out: [],
      err: [
        `Error fetching POST  ${url}/api/run_test_function 400 Bad Request: InvalidTestQuery: Only \`export default\` is supported.`,
      ],
    });
  });

  test("Convex's refusals, before any request", async () => {
    const dir = tmp();
    // No deployment is needed to refuse: none is configured here.
    const url = "http://127.0.0.1:9";
    expect(await run(dir, url, "items:list", "--inline-query", "1")).toEqual({
      code: 1,
      out: [],
      err: ["`bunvex run` accepts either <functionName> or `--inline-query`, not both."],
    });
    expect(await run(dir, url)).toEqual({
      code: 1,
      out: [],
      err: ["`bunvex run` requires either <functionName> or `--inline-query`."],
    });
    expect((await run(dir, url, "--inline-query", "   ")).err).toEqual(["`--inline-query` must not be empty."]);
    expect(await run(dir, url, "--inline-query", "1", "--identity", "{}")).toEqual({
      code: 1,
      out: [],
      err: ["`--inline-query` can't be combined with `--identity`."],
    });
    // Commander's conflict, with `run`'s help after it, as every argument error of Convex's `run` (STUDY-124).
    const both = await run(dir, url, "--inline-query", "1", "--watch");
    expect([both.code, both.out, both.err.slice(0, 2)]).toEqual([
      1,
      [],
      ["error: option '--inline-query <query>' cannot be used with option '-w, --watch'", ""],
    ]);
    expect((await run(dir, url, "-w", "--inline-query=1")).code).toBe(1);
    expect((await run(dir, url, "--inline-query")).err[0]).toBe("error: option '--inline-query <query>' argument missing");
    // Components (DV-391).
    for (const flag of [["--component", "workflow"], ["--typecheck-components"], ["--live-component-sources"]])
      expect(await run(dir, url, "--inline-query", "1", ...flag)).toEqual({
        code: 2,
        out: [],
        err: [`bunvex run: ${flag[0]}: bunvex does not have components yet.`],
      });
    expect((await run(dir, url, "items:list", "--component=x")).code).toBe(2);
  });

  test("--push deploys first; --no-push undoes it", async () => {
    const url = await deployment();
    const dir = tmp();
    mkdirSync(join(dir, "bunvex"));
    writeFileSync(
      join(dir, "bunvex/hello.ts"),
      `import { mutation } from ${JSON.stringify(SERVER)};\nexport const seed = mutation(async ({ db }) => { await db.insert("pushed", {}); });`,
    );
    const q = '(await ctx.db.query("pushed").collect()).length';
    const notPushed = await run(dir, url, "--inline-query", q, "--push", "--no-push");
    expect(notPushed.out).toEqual(["0"]);
    expect((await run(dir, url, "hello:seed")).code).toBe(1); // not deployed
    const pushed = await run(dir, url, "--inline-query", q, "--push", "--typecheck=disable");
    expect(pushed.code).toBe(0);
    expect(pushed.out.at(-1)).toBe("0");
    expect((await run(dir, url, "hello:seed")).code).toBe(0);
    expect((await run(dir, url, "--inline-query", q)).out).toEqual(["1"]);
  });
});

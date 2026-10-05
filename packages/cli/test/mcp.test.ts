// `bunvex mcp start` (STUDY-121), driven as an MCP client drives it: the command started as a process, JSON-RPC
// over its stdin and stdout, against a running test deployment. One test per tool, the production guards
// (a self-hosted deployment is production, DV-395; a local one is not), `--disable-tools`, Convex's errors.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { type Io, main } from "../src/index.ts";
import { limitLogs } from "../src/mcp-tools.ts";
import { memoryStore } from "./memory-store.ts";

const SECRET = "56".repeat(32);
const NAME = "mcp-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const SERVER = ["bunvex", "server"].join("/");
const VALUES = ["bunvex", "values"].join("/");
const BIN = join(import.meta.dir, "../bin/bunvex.ts");

const APP: Record<string, string> = {
  "bunvex/schema.ts": `import { defineSchema, defineTable } from ${JSON.stringify(SERVER)};
import { v } from ${JSON.stringify(VALUES)};
export default defineSchema({ messages: defineTable({ body: v.string() }).index("by_body", ["body"]) });`,
  "bunvex/messages.ts": `import { mutation, query } from ${JSON.stringify(SERVER)};
import { v } from ${JSON.stringify(VALUES)};
export const send = mutation({ args: { body: v.string() }, handler: async ({ db }, { body }) => {
  console.log("sending", body);
  return db.insert("messages", { body });
} });
export const list = query({ args: {}, handler: async ({ db }) => (await db.query("messages").collect()).map((m) => m.body) });
export const fail = query({ args: {}, handler: async () => { throw new Error("broken"); } });`,
};

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-mcp-"));
  dirs.push(d);
  return d;
};

let url: string;
let project: string;
beforeAll(async () => {
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
  url = `http://127.0.0.1:${s.server.port}`;
  project = tmp();
  for (const [p, text] of Object.entries(APP)) {
    mkdirSync(join(project, p, ".."), { recursive: true });
    writeFileSync(join(project, p), text);
  }
  writeFileSync(join(project, ".env.local"), `BUNVEX_SELF_HOSTED_URL=${url}\nBUNVEX_SELF_HOSTED_ADMIN_KEY=${KEY}\n`);
  const io: Io = { env: {}, cwd: project, out: () => {}, err: () => {} };
  expect(await main(["deploy", "--typecheck=disable"], io)).toBe(0);
  process.on("beforeExit", () => {
    void s.shutdown();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
});

/** The server as a process, and a client speaking newline-delimited JSON-RPC to it. */
async function mcp(...args: string[]) {
  const p = Bun.spawn(["bun", BIN, "mcp", "start", ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  stops.push(() => {
    p.kill();
    return p.exited;
  });
  const waiting = new Map<number, (m: any) => void>();
  void (async () => {
    let buf = "";
    for await (const chunk of p.stdout) {
      buf += new TextDecoder().decode(chunk);
      for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        waiting.get(m.id)?.(m);
      }
    }
  })();
  let id = 0;
  const send = (m: object) => {
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    p.stdin.flush();
  };
  const request = (method: string, params: object) =>
    new Promise<any>((done) => {
      waiting.set(++id, done);
      send({ id, method, params });
    });
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  send({ method: "notifications/initialized" });
  /** A tool's answer: the parsed text, and whether it is an error. */
  const call = async (name: string, args?: object) => {
    const r = await request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) });
    return { isError: r.result.isError === true, value: JSON.parse(r.result.content[0].text) };
  };
  return { init, request, call, process: p };
}

const selectorOf = async (c: Awaited<ReturnType<typeof mcp>>) =>
  (await c.call("status", { projectDir: project })).value.availableDeployments[0].deploymentSelector as string;

describe("bunvex mcp start", () => {
  test("initialize names bunvex's server; tools/list is Convex's tools without insights, zod's JSON Schemas", async () => {
    const c = await mcp();
    expect(c.init.result.serverInfo).toEqual({ name: "Bunvex MCP Server", version: "0.0.1" });
    const { tools } = (await c.request("tools/list", {})).result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual([
      "status",
      "data",
      "tables",
      "functionSpec",
      "run",
      "envList",
      "envGet",
      "envSet",
      "envRemove",
      "runOneoffQuery",
      "logs",
    ]);
    const data = tools.find((t: { name: string }) => t.name === "data");
    expect(data.inputSchema).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      required: ["deploymentSelector", "tableName", "order"],
      additionalProperties: false,
      properties: { order: { type: "string", enum: ["asc", "desc"] }, limit: { type: "number", maximum: 1000 } },
    });
    for (const t of tools) expect(JSON.stringify(t)).not.toMatch(/convex/i);
  });

  test("status: the project's deployment; self-hosted is production, read-only by default", async () => {
    const c = await mcp();
    const s = await c.call("status", { projectDir: project });
    expect(s.isError).toBe(false);
    const [d] = s.value.availableDeployments;
    expect(d).toMatchObject({ kind: "prod", url, readOnly: true });
    expect(JSON.parse(atob(d.deploymentSelector.split(":")[1]))).toEqual({
      projectDir: project,
      deployment: { kind: "prod" },
    });
    expect(await c.call("status", {})).toEqual({
      isError: true,
      value: {
        error:
          "No project directory provided. Either provide the `projectDir` argument or configure the MCP server with the `--project-dir` flag.",
      },
    });
    const pii = await mcp("--project-dir", project, "--cautiously-allow-production-pii");
    expect((await pii.call("status", {})).value.availableDeployments[0].readOnly).toBe(false);
    const full = await mcp("--dangerously-enable-production-deployments");
    expect((await full.call("status", { projectDir: project })).value.availableDeployments[0].readOnly).toBeUndefined();
  });

  test("the guards on production: mutating tools and PII refused; schemas and specs allowed", async () => {
    const c = await mcp();
    const sel = await selectorOf(c);
    const prod =
      "This tool cannot be used with production deployments. Use a read-only tool like `tables` instead, or enable production access with --dangerously-enable-production-deployments.";
    const pii =
      "This read-only tool may expose PII from production. Enable with --cautiously-allow-production-pii, or use --dangerously-enable-production-deployments for full access.";
    expect(await c.call("run", { deploymentSelector: sel, functionName: "messages:list", args: "{}" })).toEqual({
      isError: true,
      value: { error: prod },
    });
    for (const name of ["envList", "envGet", "envSet", "envRemove"])
      expect((await c.call(name, { deploymentSelector: sel, name: "A", value: "1" })).value.error).toBe(prod);
    expect((await c.call("data", { deploymentSelector: sel, tableName: "messages", order: "asc" })).value.error).toBe(
      pii,
    );
    expect((await c.call("logs", { deploymentSelector: sel })).value.error).toBe(pii);
    expect((await c.call("runOneoffQuery", { deploymentSelector: sel, query: "x" })).value.error).toBe(pii);
    expect((await c.call("tables", { deploymentSelector: sel })).isError).toBe(false);
    expect((await c.call("functionSpec", { deploymentSelector: sel })).isError).toBe(false);
    // PII allowed: the read-only tools, not the others.
    const p = await mcp("--cautiously-allow-production-pii");
    expect((await p.call("data", { deploymentSelector: sel, tableName: "messages", order: "asc" })).isError).toBe(
      false,
    );
    expect(
      (await p.call("run", { deploymentSelector: sel, functionName: "messages:list", args: "{}" })).value.error,
    ).toBe(prod);
    // A forged selector does not lift the guard: production is the deployment's, not the selector's.
    const forged = `local:${btoa(JSON.stringify({ projectDir: project, deployment: { kind: "local" } }))}`;
    expect(
      (await c.call("run", { deploymentSelector: forged, functionName: "messages:list", args: "{}" })).value.error,
    ).toBe(prod);
  });

  test("a local deployment is not production: every tool, no flag", async () => {
    const local = tmp();
    mkdirSync(join(local, ".bunvex/local/default"), { recursive: true });
    const port = Number(new URL(url).port);
    writeFileSync(
      join(local, ".bunvex/local/default/config.json"),
      JSON.stringify({
        ports: { cloud: port, site: port + 1 },
        backendVersion: "x",
        adminKey: KEY,
        instanceSecret: SECRET,
        deploymentName: NAME,
      }),
    );
    writeFileSync(join(local, ".env.local"), "BUNVEX_DEPLOYMENT=local:mcp-test\n");
    mkdirSync(join(local, "bunvex"));
    const c = await mcp();
    const s = await c.call("status", { projectDir: local });
    expect(s.value.availableDeployments).toEqual([
      expect.objectContaining({ kind: "local", url: `http://127.0.0.1:${port}` }),
    ]);
    expect(s.value.availableDeployments[0].readOnly).toBeUndefined();
    const sel = s.value.availableDeployments[0].deploymentSelector;
    const r = await c.call("run", { deploymentSelector: sel, functionName: "messages:list", args: "{}" });
    expect(r.isError).toBe(false);
  });

  describe("each tool (production enabled)", () => {
    let c: Awaited<ReturnType<typeof mcp>>;
    let sel: string;
    const setup = async () => {
      c = await mcp("--dangerously-enable-production-deployments");
      sel = await selectorOf(c);
    };

    test("run: the result and Convex's log lines; JSON5 arguments; errors", async () => {
      await setup();
      const r = await c.call("run", { deploymentSelector: sel, functionName: "messages:send", args: "{ body: 'hi' }" });
      expect(r.isError).toBe(false);
      expect(typeof r.value.result).toBe("string");
      expect(r.value.logLines).toEqual([
        "info: %c[BUNVEX ?(messages:send)] [LOG] color:rgb(0, 145, 255) 'sending' 'hi'",
      ]);
      expect(
        (await c.call("run", { deploymentSelector: sel, functionName: "api.messages.list", args: "{}" })).value.result,
      ).toContain("hi");
      const bad = await c.call("run", { deploymentSelector: sel, functionName: "messages:list", args: "{" });
      expect(bad.value.error).toStartWith('Failed to parse arguments as JSON: "{"');
      const failed = await c.call("run", { deploymentSelector: sel, functionName: "messages:fail", args: "{}" });
      expect(failed.value.error).toStartWith('Failed to run function "messages:fail":\n');
      expect(failed.value.error).toContain("broken");
    });

    test("data: a page of a table", async () => {
      await setup();
      await c.call("run", { deploymentSelector: sel, functionName: "messages:send", args: '{"body":"page"}' });
      const r = await c.call("data", { deploymentSelector: sel, tableName: "messages", order: "desc", limit: 1 });
      expect(r.isError).toBe(false);
      expect(r.value.page).toHaveLength(1);
      expect(r.value.page[0]).toMatchObject({ body: "page" });
      expect(r.value.isDone).toBe(false);
      expect(typeof r.value.continueCursor).toBe("string");
      // zod's checks: Convex's limit.
      const over = await c.call("data", { deploymentSelector: sel, tableName: "messages", order: "asc", limit: 5000 });
      expect(over.isError).toBe(true);
      expect(over.value.error).toContain("limit");
    });

    test("tables: the declared schema and the inferred shapes", async () => {
      await setup();
      const r = await c.call("tables", { deploymentSelector: sel });
      expect(r.isError).toBe(false);
      expect(r.value.tables.messages.schema).toMatchObject({
        tableName: "messages",
        indexes: [{ indexDescriptor: "by_body", fields: ["body"] }],
        searchIndexes: [],
        vectorIndexes: [],
      });
      expect(r.value.tables.messages.inferredSchema).toBeDefined();
    });

    test("functionSpec: the deployment's functions, as JSON", async () => {
      await setup();
      const r = await c.call("functionSpec", { deploymentSelector: sel });
      const ids = (r.value as { identifier?: string }[]).map((f) => f.identifier).sort();
      expect(ids).toEqual(["messages.js:fail", "messages.js:list", "messages.js:send"]);
    });

    test("envSet, envGet, envList, envRemove", async () => {
      await setup();
      expect((await c.call("envSet", { deploymentSelector: sel, name: "MCP_VAR", value: "one" })).value).toEqual({
        success: true,
      });
      expect((await c.call("envGet", { deploymentSelector: sel, name: "MCP_VAR" })).value).toEqual({ value: "one" });
      const list = (await c.call("envList", { deploymentSelector: sel })).value.variables;
      expect(list).toContainEqual(expect.objectContaining({ name: "MCP_VAR", value: "one" }));
      expect((await c.call("envRemove", { deploymentSelector: sel, name: "MCP_VAR" })).value).toEqual({
        success: true,
      });
      expect((await c.call("envGet", { deploymentSelector: sel, name: "MCP_VAR" })).value).toEqual({ value: null });
      const bad = await c.call("envSet", { deploymentSelector: sel, name: "1bad", value: "x" });
      expect(bad.value.error).toStartWith(
        `Error fetching POST  ${url}/api/update_environment_variables 400 Bad Request: `,
      );
    });

    test("runOneoffQuery: the module's value and lines; `Query failed`", async () => {
      await setup();
      const q = `import { query } from "bunvex:/_system/repl/wrappers.js";
export default query({ handler: async (ctx) => { console.log("n"); return (await ctx.db.query("messages").collect()).length >= 0; } });`;
      expect((await c.call("runOneoffQuery", { deploymentSelector: sel, query: q })).value).toEqual({
        result: true,
        logLines: ["[LOG] 'n'"],
      });
      const failed = await c.call("runOneoffQuery", {
        deploymentSelector: sel,
        query: q.replace("console.log", "throw new Error('q'); console.log"),
      });
      expect(failed.value.error).toStartWith('Query failed: {\n  "status": "error"');
      const refused = await c.call("runOneoffQuery", { deploymentSelector: sel, query: "export default 1;" });
      expect(refused.value.error).toBe(
        `Error fetching POST  ${url}/api/run_test_function 400 Bad Request: InvalidTestQuery: Default export is not a bunvex function.`,
      );
    });

    test("logs: text or JSONL, the status filter, the limits", async () => {
      await setup();
      await c.call("run", { deploymentSelector: sel, functionName: "messages:send", args: '{"body":"logged"}' });
      await c.call("run", { deploymentSelector: sel, functionName: "messages:fail", args: "{}" });
      const text = await c.call("logs", { deploymentSelector: sel, cursor: 0 });
      expect(text.isError).toBe(false);
      expect(text.value.entries).toContain("[BUNVEX M(messages:send)] [LOG] 'sending' 'logged'");
      expect(typeof text.value.newCursor).toBe("number");
      const failures = await c.call("logs", { deploymentSelector: sel, status: "failure", jsonl: true });
      const entries = failures.value.entries.split("\n").map((l: string) => JSON.parse(l));
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) expect(e.error).toBeTruthy();
      const one = await c.call("logs", { deploymentSelector: sel, jsonl: true, entriesLimit: 1 });
      expect(one.value.entries.split("\n")).toHaveLength(1);
      expect((await c.call("logs", { deploymentSelector: sel, jsonl: true, tokensLimit: 1 })).value.entries).toBe("");
    });
  });

  test("--disable-tools: a disabled tool is not listed nor callable; insights is accepted; an unknown name fails", async () => {
    const c = await mcp("--disable-tools", "data, logs,insights");
    const names = (await c.request("tools/list", {})).result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("data");
    expect(names).not.toContain("logs");
    expect(names).toContain("tables");
    expect(await c.call("data", { deploymentSelector: "x" })).toEqual({
      isError: true,
      value: { error: "Tool data not found" },
    });
    const bad = Bun.spawnSync(["bun", BIN, "mcp", "start", "--disable-tools", "nope"], {
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString().trim()).toBe(
      "Failed to start MCP server: Error: Disabled tool nope not found (valid tools: data, envGet, envList, envRemove, envSet, functionSpec, logs, run, runOneoffQuery, status, tables)",
    );
  });

  test("Convex's call errors: no arguments; a bad selector; the deprecated flag's conflict", async () => {
    const c = await mcp();
    expect(await c.call("status")).toEqual({ isError: true, value: { error: "No arguments provided" } });
    expect((await c.call("tables", { deploymentSelector: "garbage" })).isError).toBe(true);
    const conflict = Bun.spawnSync(
      ["bun", BIN, "mcp", "start", "--disable-production-deployments", "--dangerously-enable-production-deployments"],
      { env: { PATH: process.env.PATH ?? "" } },
    );
    expect(conflict.exitCode).toBe(2);
    expect(conflict.stderr.toString()).toContain(
      "option '--disable-production-deployments' cannot be used with option '--dangerously-enable-production-deployments'",
    );
  });

  test("concurrent calls all answer (they run one at a time)", async () => {
    const c = await mcp("--dangerously-enable-production-deployments");
    const sel = await selectorOf(c);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        c.call("run", { deploymentSelector: sel, functionName: "messages:send", args: `{"body":"c${i}"}` }),
      ),
    );
    for (const r of results) expect(r.isError).toBe(false);
  });
});

describe("limitLogs (Convex's)", () => {
  test("the last entries, then a token budget from the oldest kept", () => {
    const e = [{ a: "x".repeat(30) }, { b: 1 }, { c: 2 }];
    expect(limitLogs(e, 20000, 2)).toEqual([{ b: 1 }, { c: 2 }]);
    expect(limitLogs(e, 5, 3)).toEqual([]);
    expect(limitLogs(e, 20000, 3)).toEqual(e);
  });
});

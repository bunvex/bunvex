// A function's error, as the app sees it after a real push (STUDY-95): only the frames of its own code — none of
// the server's — each mapped through the pushed source map to its original file (named as Convex's bundler names
// it, `../bunvex/…`), line and column. Seen the same by the client, `bunvex run`, a push that fails at import, and
// a caller of a nested function.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { type Io, main } from "../src/index.ts";
import { memoryStore } from "./memory-store.ts";

const SECRET = "cd".repeat(32);
const NAME = "stacks-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
// The app's imports, spelled so the dependency checker does not take them for this test's own.
const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const API = JSON.stringify("./_generated/api");
const TINY_LIB = JSON.stringify(["tiny", "lib"].join("-"));

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

/** The app: a mutation calling a helper in another module that throws, a dependency that throws, nested calls. */
const APP: Record<string, string> = {
  "bunvex/lib/check.ts": `export function assertShort(body: string) {
  if (body.length > 5) {
    throw new Error("too long");
  }
}
`,
  "bunvex/posts.ts": `import { mutation, internalMutation } from ${SERVER};
import { assertShort } from "./lib/check";
import { explode } from ${TINY_LIB};
import { internal } from ${API};

export const send = mutation(async (_ctx, { body }: { body: string }) => {
  assertShort(body);
  return body;
});

export const viaDependency = mutation(async () => {
  return explode();
});

export const inner = internalMutation(async () => {
  assertShort("much too long");
});

export const outer = mutation(async (ctx) => {
  await ctx.runMutation(internal.posts.inner, {});
});
`,
  "node_modules/tiny-lib/package.json": `{ "name": "tiny-lib", "version": "1.0.0", "main": "index.js" }`,
  "node_modules/tiny-lib/index.js": `exports.explode = function explode() {
  throw new Error("from the dependency");
};
`,
};

function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const it: Io = { env: {}, cwd, out: (l) => out.push(l), err: (l) => err.push(l) };
  return { it, out, err };
}

async function deployed(files: Record<string, string> = APP) {
  const dir = tmp("bunvex-stacks-");
  const engine = await new Engine(defineSchema({}), new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }), {
    instanceName: NAME,
    instanceSecret: SECRET,
    storedSchema: true,
  }).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    moduleStorage: memoryStore() as never,
    redactLogsToClient: false,
  });
  cleanup.push(() => s.shutdown());
  const url = `http://127.0.0.1:${s.server.port}`;
  const app = tmp("bunvex-stacks-app-");
  write(app, files);
  write(app, { ".env.local": `BUNVEX_SELF_HOSTED_URL=${url}\nBUNVEX_SELF_HOSTED_ADMIN_KEY="${KEY}"\n` });
  const push = io(app);
  const code = await main(["deploy", "--typecheck=disable"], push.it);
  const mutation = async (path: string, args: object = {}) =>
    (await (
      await fetch(`${url}/api/mutation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args }),
      })
    ).json()) as { status: string; errorMessage: string };
  return { app, code, push, mutation };
}

/** What no app should see in a frame: the server's files, Node's modules, the bundled module names. */
function expectOnlyAppFrames(message: string) {
  const frames = message.split("\n").filter((l) => /^ {4}at /.test(l));
  expect(frames.length).toBeGreaterThan(0);
  for (const f of frames) {
    expect(f).not.toMatch(/packages\/|node:|\b_deps\/|\(\w+\.js:/);
    expect(f).toMatch(/\((\.\.\/)+(bunvex|node_modules)\/[^)]+:\d+:\d+\)$/);
  }
}

describe("a function's error stack", () => {
  test("the client sees the app's frames only, mapped to its .ts sources, lines and columns", async () => {
    const d = await deployed();
    expect(d.code).toBe(0);
    const r = await d.mutation("posts:send", { body: "much too long" });
    expect(r.status).toBe("error");
    expectOnlyAppFrames(r.errorMessage);
    // The throw (line 3, in a shared chunk: `out/_deps/…` names it `../../bunvex/…`), then the call (line 7).
    expect(r.errorMessage).toMatch(
      /\nUncaught Error: too long\n {4}at assertShort\d* \(\.\.\/\.\.\/bunvex\/lib\/check\.ts:3:\d+\)\n {4}at <anonymous> \(\.\.\/bunvex\/posts\.ts:7:3\)\n$/,
    );
  });

  test("a bundled dependency's frame names its file under node_modules, as Convex's", async () => {
    const d = await deployed();
    const r = await d.mutation("posts:viaDependency");
    expectOnlyAppFrames(r.errorMessage);
    expect(r.errorMessage).toMatch(/ {4}at \$?explode \((\.\.\/)+node_modules\/tiny-lib\/index\.js:2:\d+\)\n/);
    expect(r.errorMessage).toMatch(/ {4}at <anonymous> \(\.\.\/bunvex\/posts\.ts:12:\d+\)\n$/);
  });

  test("a nested function's frames reach its caller mapped", async () => {
    const d = await deployed();
    const r = await d.mutation("posts:outer");
    expectOnlyAppFrames(r.errorMessage);
    expect(r.errorMessage).toContain("check.ts:3:");
    expect(r.errorMessage).toMatch(/\.\.\/bunvex\/posts\.ts:20:\d+\)/);
  });

  test("`bunvex run` prints the same frames", async () => {
    const d = await deployed();
    const r = io(d.app);
    expect(await main(["run", "posts:send", '{ body: "much too long" }'], r.it)).toBe(1);
    const printed = r.err.join("\n");
    expect(printed).toContain("Uncaught Error: too long");
    expect(printed).toMatch(/at assertShort\d* \(\.\.\/\.\.\/bunvex\/lib\/check\.ts:3:\d+\)/);
    expect(printed).not.toMatch(/packages\/server|_deps\/|posts\.js/);
  });

  test("a push failing at import: the module's frame mapped", async () => {
    const d = await deployed({
      "bunvex/broken.ts": `import { query } from ${SERVER};

export const q = query(async () => 1);
throw new Error("at import");
`,
    });
    expect(d.code).toBe(1);
    const printed = d.push.err.join("\n");
    expect(printed).toContain("Uncaught Error: at import");
    expect(printed).toMatch(/at \(?\.\.\/bunvex\/broken\.ts:4:\d+\)?/);
    // `Failed to analyze broken.js:` names the module, as Convex's; its frames name the source.
    expect(printed.split("\n").filter((l) => /^ {4}at /.test(l))).toEqual([
      expect.stringMatching(/^ {4}at \.\.\/bunvex\/broken\.ts:4:\d+$/),
    ]);
  });
});

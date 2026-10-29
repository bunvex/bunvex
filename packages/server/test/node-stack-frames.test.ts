// A "use node" action's `error.stack` keeps Node's own frames (`node:https`, `node:_http_client`), as Convex's Node
// executor keeps them (`node-executor/src/errors.ts` `registerPrepareStackTrace`, "proxy-agents depends on
// Node-formatted frames"), and still no frame or path of the server's (DV-482 as amended, STUDY-188 §X11 / Q2).
// agent-base (7.1.4, 9.0.0; under https-proxy-agent) tells an https request from an http one, when the request
// sets neither `secureEndpoint` nor `protocol`, by looking for `node:https:` in a fresh `new Error().stack`; its
// `get protocol()` answers with it, and Bun's `ClientRequest` refuses an https request whose agent says "http:".
// The check below is agent-base's `isSecureEndpoint`, as the library reads the stack. A V8 function's stack and the
// client's error keep no Node frame (Convex maps both through source maps, `JsError::from_frames`). STUDY-171's
// `process` sandbox does not run "use node" actions yet, so only `vm` (the default) has Node contexts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SERVER = JSON.stringify(["@bunvex", "server"].join("/"));
const REPO = resolve(import.meta.dir, "../../..");

const NODE_MODULE = `"use node";
import { action } from ${SERVER};
import http from "node:http";
import https from "node:https";

// agent-base's isSecureEndpoint (dist/index.js, 7.1.4 and 9.0.0), as it reads the stack.
function isSecureEndpoint(options) {
  if (options) {
    if (typeof options.secureEndpoint === "boolean") return options.secureEndpoint;
    if (typeof options.protocol === "string") return options.protocol === "https:";
  }
  const { stack } = new Error();
  if (typeof stack !== "string") return false;
  return stack.split("\\n").some((l) => l.indexOf("(https.js:") !== -1 || l.indexOf("node:https:") !== -1);
}

// agent-base 9.0.0's \`get protocol()\`, which Bun's ClientRequest reads.
class Agent extends http.Agent {
  seen = [];
  get protocol() {
    const secure = isSecureEndpoint();
    this.seen.push({ secure, stack: new Error().stack });
    return secure ? "https:" : "http:";
  }
  set protocol(v) {}
}

export const proxied = action(async () => {
  const agent = new Agent();
  let threw = null;
  try {
    const req = https.request({ host: "127.0.0.1", port: 9, path: "/", agent });
    req.on("error", () => {});
    req.destroy();
  } catch (e) {
    threw = e.message;
  }
  return { threw, secure: agent.seen[0]?.secure ?? null, stack: agent.seen[0]?.stack ?? null };
});

export const plain = action(async () => {
  try { throw new Error("mine"); } catch (e) { return e.stack; }
});

export const uncaught = action(async () => {
  const agent = new (class extends http.Agent {
    get protocol() { throw new Error("from the agent"); }
    set protocol(v) {}
  })();
  https.request({ host: "127.0.0.1", port: 9, path: "/", agent });
});
`;

const V8_MODULE = `
import { action } from ${SERVER};
export const plain = action(async () => {
  try { await Promise.resolve(); [1].map(() => { throw new Error("mine"); }); } catch (e) { return e.stack; }
});
`;

type Outcome = { status: string; value?: unknown; errorMessage?: string };

/** A frame or a path of the server's own, anywhere in a text. */
const serverLeak = (t: string) =>
  t.includes(REPO) ||
  /packages\/(core|server|values|sandbox)\/|node_modules\/|bunvex-runtime:|bunvex:\/v\d|node:async_hooks/.test(t);

let call: (path: string) => Promise<Outcome>;
let stop: () => unknown;

beforeAll(async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    moduleStorage: new MemoryBlobStore(),
    redactLogsToClient: false,
  });
  stop = () => s.shutdown();
  await s.deployCode([
    { path: "n.js", source: NODE_MODULE, environment: "node" },
    { path: "v.js", source: V8_MODULE, environment: "isolate" },
  ]);
  call = async (path) => {
    const r = await fetch(`http://127.0.0.1:${s.server.port}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: {} }),
    });
    return (await r.json()) as Outcome;
  };
}, 30_000);
afterAll(() => stop?.());

describe('a "use node" action\'s error.stack', () => {
  test("agent-base's check finds `node:https:` in it: the https request goes through", async () => {
    const o = await call("n:proxied");
    expect(o.status).toBe("success");
    const { threw, secure, stack } = o.value as { threw: string | null; secure: boolean; stack: string };
    expect({ threw, secure }).toEqual({ threw: null, secure: true });
    // Node's frames between the app's, as they are; the app's mapped; none of the server's.
    expect(stack).toMatch(/^Error\n {4}at protocol \(n\.js:\d+:\d+\)\n/);
    expect(stack).toMatch(/\n {4}at request \(node:https:\d+:\d+\)\n/);
    expect(stack).toMatch(/\n {4}at ClientRequest \(node:_http_client:\d+:\d+\)\n/);
    expect(stack).toMatch(/\n {4}at <anonymous> \(n\.js:\d+:\d+\)$/);
    expect({ stack, leak: serverLeak(stack) }).toEqual({ stack, leak: false });
  });

  test("the app's own error: Node's header, then its frames, none past the handler", async () => {
    expect((await call("n:plain")).value).toMatch(/^Error: mine\n {4}at <anonymous> \(n\.js:\d+:\d+\)$/);
  });
});

test("the client's error and a V8 function's stack keep no Node frame", async () => {
  const u = await call("n:uncaught");
  expect(u.status).toBe("error");
  expect(u.errorMessage).toContain("Uncaught Error: from the agent\n    at protocol (n.js:");
  expect(u.errorMessage).not.toContain("(node:");
  expect(serverLeak(u.errorMessage!)).toBe(false);
  const v = (await call("v:plain")).value as string;
  expect(v).toMatch(/^ {4}at <anonymous> \(v\.js:\d+:\d+\)\n/);
  expect(v).not.toContain("node:");
});

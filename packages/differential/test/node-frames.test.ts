// Node's own frames in a "use node" action's `error.stack` (STUDY-188 §X11, DV-482 as amended by Q2), on Convex's
// backend (the oracle) and on bunvex's, the app of `node-frames-app/` deployed by each CLI with https-proxy-agent
// 9.1.0 bundled in. Its agent-base finds `node:https:` in a fresh stack when an https request sets neither
// `secureEndpoint` nor `protocol`, and answers "https:" for the agent's protocol; without those frames Bun refuses
// the request when it is made ('Protocol "https:" not supported. Expected "http:"'). Compared: whether the request is
// refused, the protocol agent-base answers outside a request, and the stack an agent sees when the request reads its
// protocol: its header and the Node frames above the app's call, positions aside (Node's and Bun's sources differ).
// The app's own frames differ by decision (DV-482: mapped, named as bunvex names them) and are not compared; nor is
// what follows the app's call (Convex's executor frames, none of bunvex's server). Local only: skipped, with a note,
// when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`node-frames: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../node-frames-app");
const REPO = resolve(import.meta.dir, "../../..");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const value = async (b: Backend, path: string) => {
  const { body } = await b.call("action", path, {});
  const a = body as { status: string; value?: unknown; errorMessage?: string };
  expect({ path, status: a.status, error: a.errorMessage }).toEqual({ path, status: "success", error: undefined });
  return a.value;
};

/** A frame of Node's own, its position left out: `at request (node:https)`. */
const isNode = (l: string) => /^ {4}at .*\(node:[^)]*\)$/.test(l);
const unpositioned = (l: string) => l.replace(/(\(node:[^:)]*)(?::\d+)*\)$/, "$1)");

/** A stack's header, then the Node frames between the app's first frame and the next of its own. */
function shape(stack: string) {
  const lines = stack.split("\n");
  const frames = lines.slice(1);
  const between: string[] = [];
  for (const l of frames.slice(1)) {
    if (!isNode(l)) break;
    between.push(unpositioned(l));
  }
  return { head: lines[0], firstIsApp: !isNode(frames[0] ?? ""), between };
}

describe.skipIf(!ready)("Node's frames in a Node action's stack, against Convex's backend", () => {
  test("https-proxy-agent: the https request is made, agent-base answers as on Convex", async () => {
    const [c, b] = [await value(convex, "node:proxied"), await value(bunvex, "node:proxied")];
    expect(c).toEqual({ threw: null, outside: "http:" });
    expect(b).toEqual(c);
  });

  test("the stack an agent sees: `Error`, the app's frame, then Node's, as Convex's", async () => {
    const [c, b] = [await value(convex, "node:stack"), await value(bunvex, "node:stack")];
    const [cs, bs] = [(c as { stack: string }).stack, (b as { stack: string }).stack];
    expect(shape(cs).between.length).toBeGreaterThan(0);
    expect({ shape: shape(bs), threw: (b as { threw: unknown }).threw }).toEqual({
      shape: shape(cs),
      threw: (c as { threw: unknown }).threw,
    });
    // No frame nor path of bunvex's server.
    expect({
      bs,
      leaks: bs.includes(REPO) || /packages\/|node_modules\/|bunvex-runtime:|bunvex:\/v\d|node:async_hooks/.test(bs),
    }).toEqual({ bs, leaks: false });
  });
});

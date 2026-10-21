// Unhandled rejections (STUDY-171 §13) on Convex's backend (the oracle) and on bunvex's under the `process` function
// sandbox (`BUNVEX_FUNCTION_SANDBOX=process`): queries, mutations and actions of `rejections-app/` that leave a
// promise rejected with no handler — before and after an operation, in a helper, in an operation they did not await,
// in an action's timer, with values that are not errors and with application errors, an action's operation started in
// the same turn — and the cases where a handler
// comes in time, the error caught by a caller, a mutation's writes rolled back, an action stopped. Convex fails the
// function once the microtask queue has drained (`crates/isolate/src/environment/udf/mod.rs` and
// `environment/action/mod.rs`, `UnhandledPromiseRejection`); under `vm` bunvex does not (DV-528), so this suite runs
// `process` only. Compared: the status, the error's first line, its data, the value, the log lines (Convex's docs
// link dropped, DV-04), whether the error has the app's frames (their names and positions are DV-345 and DV-346),
// and what the writes left. Local only: skipped, with a note, when Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`unhandled-rejections: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../rejections-app");
const DOCS_LINK = / See https:\/\/docs\.convex\.dev\/functions\/actions#dangling-promises for more information\./;
const PROCESS = { BUNVEX_FUNCTION_SANDBOX: "process", BUNVEX_FUNCTION_SANDBOX_ISOLATION: "none" };

let convex: Backend;
let bunvex: Backend;
/** What `stopsBeforeFetch`'s `fetch` is sent to. */
let target: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!ready) return;
  target = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("ok"),
  });
  [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP, env: PROCESS })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
  target?.stop(true);
});

const SHARED = [
  "rejected",
  "rejectedAfterOp",
  "rejectedBeforeOp",
  "handledInTime",
  "handledAfterOp",
  "asyncHelper",
  "plainValue",
  "numberValue",
  "objectValue",
  "undefinedValue",
  "typeError",
  "applicationError",
  "applicationErrorString",
  "unawaitedOp",
  "unawaitedNested",
  "unawaitedOpHandledLater",
  "nestedHandledAfterRead",
  "readHandledAfterNested",
  "nestedRejectionCaught",
  "throws",
  "rejectedThenThrows",
];
/** Nested calls started and not awaited before the function returns (`rejections-app`, `unawaitedMany…`). */
const UNAWAITED = [1, 2, 10].flatMap((n) =>
  ["unawaitedMany", "unawaitedManyFail", "unawaitedChain", "unawaitedChainFail", "unawaitedChainCaught"].map(
    (c) => `${c}${n}`,
  ),
);
const UNAWAITED_WRITES = [1, 2, 10].flatMap((n) => [`unawaitedWrites${n}`, `unawaitedWritesFail${n}`]);
const RUNS: ["query" | "mutation" | "action", string, string][] = [
  ...[...SHARED, ...UNAWAITED].map((c) => ["query", "rejections:q", c] as ["query", string, string]),
  ...[...SHARED, ...UNAWAITED, ...UNAWAITED_WRITES, "writesThenRejects", "unawaitedWrite", "nestedMutationCaught"].map(
    (c) => ["mutation", "rejections:m", c] as ["mutation", string, string],
  ),
  ...[
    "rejected",
    "plainValue",
    "applicationError",
    "handledInTime",
    "rejectedBeforeOp",
    "rejectedAfterOp",
    "handledAfterOp",
    "beforeTimer",
    "inTimer",
    "timerAfterAnswer",
    "stopsTheAction",
    "stopsBeforeOp",
    "stopsBeforeFetch",
    "unawaitedNested",
    "nestedQueryCaught",
    "nestedMutationRolledBack",
  ].map((c) => ["action", "rejections:a", c] as ["action", string, string]),
];
/**
 * Where bunvex's error has the app's frame and Convex's none: an id that does not parse is refused at the app's call
 * (Convex parses it in its async syscall, so nothing of the app's is on the stack), as for an awaited one
 * (error-frames.test.ts, STUDY-150 §6).
 */
const FRAMES_DIFFER = new Set([
  "query unawaitedOp",
  "mutation unawaitedOp",
  "mutation unawaitedWrite",
  "query readHandledAfterNested",
  "mutation readHandledAfterNested",
]);

type Answer = { status: string; value?: unknown; errorMessage?: string; errorData?: unknown; logLines?: string[] };

/** What the client gets, compared: the first line of the error (no request id), its data, frames or not, lines. */
function seen(a: Answer) {
  const lines = (a.logLines ?? []).map((l) => l.replace(DOCS_LINK, ""));
  if (a.status === "success") return { status: a.status, value: a.value, lines };
  const message = (a.errorMessage ?? "").replace(/^\[Request ID: [0-9a-f]+\] Server Error\n/, "");
  const [first = "", ...rest] = message.split("\n");
  return {
    status: a.status,
    // The application error's class is `BunvexError` on bunvex (DV-03).
    error: first.replace("ConvexError", "BunvexError"),
    data: a.errorData,
    frames: rest.some((l) => /^ {4}at .*\.\.\/(convex|bunvex)\/rejections\.ts/.test(l)),
    lines,
  };
}

describe.skipIf(!ready)("an unhandled rejection under process, against Convex's backend", () => {
  for (const [kind, path, c] of RUNS)
    test(`${kind} ${c}`, async () => {
      const args = (b: Backend) =>
        kind === "query"
          ? { c }
          : {
              c,
              tag:
                c === "stopsBeforeFetch"
                  ? `http://127.0.0.1:${target!.port}/`
                  : `${kind}-${c}-${b === convex ? "c" : "b"}`,
            };
      const [x, y] = await Promise.all([convex.call(kind, path, args(convex)), bunvex.call(kind, path, args(bunvex))]);
      const [cs, bs] = [seen(x.body as Answer), seen(y.body as Answer)];
      if (FRAMES_DIFFER.has(`${kind} ${c}`)) {
        expect({ ...bs, frames: undefined }).toEqual({ ...cs, frames: undefined });
        expect([cs.frames, bs.frames]).toEqual([false, true]);
      } else expect(bs).toEqual(cs);
    });

  test("what the writes left: a failed mutation's and a stopped action's none", async () => {
    const count = async (b: Backend, tag: string) =>
      ((await b.call("query", "rejections:count", { tag })).body as Answer).value;
    // A write that succeeds counts: the action's would have, had it run on.
    for (const b of [convex, bunvex]) await b.call("mutation", "rejections:m", { c: "writes", tag: "control" });
    // The nested mutations not awaited all ran: n writes each, none where one of them failed.
    for (const c of UNAWAITED_WRITES)
      for (const b of [convex, bunvex]) {
        const on = b === convex ? "convex" : "bunvex";
        const n = Number(/\d+$/.exec(c)![0]);
        const want = c.includes("Fail") ? 0 : n;
        expect({ on, c, count: await count(b, `mutation-${c}-${on[0]}`) }).toEqual({ on, c, count: want });
      }
    for (const tag of ["mutation-writesThenRejects", "mutation-unawaitedWrite", "action-stopsTheAction", "control"])
      for (const b of [convex, bunvex]) {
        const t =
          tag === "control" ? tag : `${tag}-${b === convex ? "c" : "b"}${tag.startsWith("action") ? "-never" : ""}`;
        const on = b === convex ? "convex" : "bunvex";
        expect({ on, tag, count: await count(b, t) }).toEqual({ on, tag, count: tag === "control" ? 1 : 0 });
      }
    // An operation `stopsBeforeOp` / `stopsBeforeFetch` started in the turn of the rejection has already started on
    // Convex (its task runs as the op is called) and may or may not finish: its write and its request are seen on some
    // runs and not others, on Convex's binary as on bunvex's. Only the answer and the warning are compared (above).
  });
});

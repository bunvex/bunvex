// A system error in an HTTP action (STUDY-171 §14.6 Q-PR6-3), on Convex's backend (the oracle) and on bunvex's: the
// routes of `http-internal-app/`. Compared for `system` (a system error in the HTTP action itself; how each backend is
// made to raise one is in the app): the status, the content type, the body whole, and the function log's entries for
// the run (its name, its lines, its status and its error, whole). And for `thrown` (the app's own error): the status
// and the first line of its trace. What a nested call's system error gives (`nested`, `caught`) differs, and is spelled
// out for each backend (an owner question). Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`http-internal-error: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../http-internal-app");
const KINDS = ["system", "nested", "caught", "thrown"];
const INTERNAL = '{"code":"InternalServerError","message":"Your request couldn\'t be completed. Try again later."}';

let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const auth = (b: Backend) => ({ authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}` });

type Entry = {
  kind: string;
  udfType: string;
  identifier: string;
  logLines: string[];
  success?: unknown;
  error?: string;
};

async function play(b: Backend) {
  const answers: Record<string, { status: number; type: string | null; body: string }> = {};
  for (const kind of KINDS) {
    const r = await fetch(`${b.url}/http/internal/${kind}`);
    answers[kind] = { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
  }
  let entries: Entry[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${b.url}/api/stream_function_logs?cursor=0`, { headers: auth(b) });
    entries = ((await r.json()) as { entries: Entry[] }).entries.filter((e) => e.udfType === "HttpAction");
    if (entries.filter((e) => e.kind === "Completion").length >= KINDS.length) break;
    await Bun.sleep(100);
  }
  const log = (path: string) =>
    entries
      .filter((e) => e.identifier === path)
      .map((e) => ({
        kind: e.kind,
        lines: e.logLines,
        ...(e.kind === "Completion" && { success: e.success ?? null, error: e.error ?? null }),
      }));
  return { answers, log };
}

const firstLine = (body: string) => (JSON.parse(body) as { trace: string }).trace.split("\n")[0];

describe.skipIf(!ready)("a system error in an HTTP action, against Convex's backend", () => {
  test("answered with the internal error, logged with its fixed message", async () => {
    const c = await play(convex);
    const b = await play(bunvex);
    expect(b.answers.system).toEqual(c.answers.system);
    expect(b.log("GET /internal/system")).toEqual(c.log("GET /internal/system"));
    expect([b.answers.thrown!.status, firstLine(b.answers.thrown!.body)]).toEqual([
      c.answers.thrown!.status,
      firstLine(c.answers.thrown!.body),
    ]);

    // What the oracle shows, spelled out.
    expect(c.answers.system).toEqual({ status: 500, type: "application/json", body: INTERNAL });
    expect(c.log("GET /internal/system")).toEqual([
      { kind: "Progress", lines: ["[LOG] 'running system'"] },
      { kind: "Completion", lines: [], success: null, error: "Your request couldn't be completed. Try again later.\n" },
    ]);

    // A nested call's system error: on Convex the action gets an Error with the fixed message (its task's error goes
    // through `resolve_promise_allow_all_errors`), so it is the app's error, catchable; on bunvex the run fails with
    // the system error (DV-209), and a `catch` sees its own message.
    expect([c.answers.nested!.status, firstLine(c.answers.nested!.body)]).toEqual([
      500,
      "Uncaught Error: Your request couldn't be completed. Try again later.",
    ]);
    expect(c.answers.caught!.body).toBe("caught: Your request couldn't be completed. Try again later.");
    expect(b.answers.nested).toEqual({ status: 500, type: "application/json", body: INTERNAL });
    expect(b.answers.caught!.body).toBe(
      "caught: Cursor was None. This should be impossible if `.next` was called on the query.",
    );
  }, 60_000);
});

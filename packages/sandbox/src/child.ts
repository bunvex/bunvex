// The function sandbox's child (STUDY-171 §7): a separate Bun process that loads an app's code for the server.
// The host starts it (`host.ts`) with a socket of its own as fd 3, both ways, and an
// environment holding only the knobs it needs; it says `hello`, then answers each request (`protocol.ts`).
//
// It loads code with the `vm` executor's own loader (`CodeVersion.load`): the same contexts, the same deterministic
// `Date` and `Math.random`, the same linking of `bunvex/*` to the server's real builders and validators, the same
// import phase and the same analysis as the server's in-process loads. So a push analyzes the same in a child as
// in-process, by construction; the parity test (test/analysis-parity.test.ts) checks it on every example app and
// on the server's pushed-code fixtures. What the child adds is the process: the wall around it is the operating
// system's (STUDY-168 PR 8), not `vm`'s.
import { installDeterminism } from "@bunvex/core";
import {
  type CodeVersion,
  FunctionExportError,
  InvalidModulesError,
  type LoadOptions,
  MissingEnvironmentVariableError,
  vmExecutor,
} from "@bunvex/server/executor";
import { ActionRuntime } from "./child-action.ts";
import { CallRuntime } from "./child-call.ts";
import { exportDefault } from "./default-export.ts";
import { chunkHeader, FrameReader, frame } from "./frames.ts";
import { PROTOCOL_VERSION, type ToChild, type ToHost, type WireError, type WireLoadOptions } from "./protocol.ts";
import { CHILD_WORK, checkpoint, childWork } from "./rejections.ts";
import { describeVersion } from "./version.ts";

/** The host's socket (`host.ts`: the 4th entry of the child's stdio). */
const CHANNEL = 3;

/** The child's exit code when the host's stream breaks: not a crash of the app's code. */
export const EXIT_BAD_STREAM = 70;

const out = Bun.file(CHANNEL).writer();
const write = (bytes: Uint8Array, flush = true) => {
  out.write(bytes);
  if (flush) void out.flush();
};
const send = (m: ToHost) => write(frame(m));

/** The versions this child loaded, by request id: the calls name the one whose function they run. */
const versions = new Map<number, CodeVersion>();
const calls = new CallRuntime(send, versions);
const actions = new ActionRuntime(
  send,
  (s, bytes) => {
    write(chunkHeader(s, bytes.byteLength), false);
    write(bytes);
  },
  versions,
);

const loadOptions = (o: WireLoadOptions): LoadOptions => ({
  seed: Uint32Array.from(o.seed),
  timestamp: o.timestamp,
  env: o.env,
  importTimeoutMs: o.importTimeoutMs,
  ...(o.nodeModules === undefined ? {} : { nodeModules: o.nodeModules }),
});

function wireError(e: unknown): WireError {
  if (e instanceof InvalidModulesError) return { kind: "InvalidModules", detail: e.detail };
  if (e instanceof FunctionExportError) return { kind: "FunctionExport", message: e.message };
  if (e instanceof MissingEnvironmentVariableError) return { kind: "MissingEnvironmentVariable", variable: e.variable };
  return { kind: "Error", message: e instanceof Error ? e.message : String(e) };
}

async function handle(m: Extract<ToChild, { t: "load" } | { t: "evaluate" }>) {
  const started = performance.now();
  try {
    if (m.t === "load") {
      // The `vm` executor's own version (its namespaces and handlers live here).
      const version = (await vmExecutor.load(m.sources, loadOptions(m.options))) as CodeVersion;
      versions.set(m.id, version);
      send({ t: "loaded", id: m.id, version: describeVersion(version), loadMs: performance.now() - started });
    } else {
      const value = await vmExecutor.evaluateDefault(
        m.source,
        { ...loadOptions(m.options), env: m.options.env, failOnMissingEnv: m.options.failOnMissingEnv },
        m.use,
      );
      send({ t: "evaluated", id: m.id, export: exportDefault(value, m.use), loadMs: performance.now() - started });
    }
  } catch (e) {
    send({ t: "failed", id: m.id, error: wireError(e) });
  }
}

/** The host broke the stream: nothing after this can be trusted. */
function badStream(why: string): never {
  process.stderr.write(`bunvex sandbox: ${why}\n`);
  process.exit(EXIT_BAD_STREAM);
}

// The deterministic globals, before any code version's contexts copy them (`contextGlobals`): in the server the
// engine installs them at its start; this process has no engine.
installDeterminism();

send({ t: "hello", protocol: PROTOCOL_VERSION, pid: process.pid });

// The host is trusted: its frames are not capped (a push's modules may be large), only checked.
const reader = new FrameReader();
for await (const chunk of Bun.file(CHANNEL).stream()) {
  let frames: ReturnType<FrameReader["push"]>;
  try {
    frames = reader.push(chunk);
  } catch (e) {
    badStream((e as Error).message);
  }
  // Each frame resumes one call's code (or the child's own work), run with its microtasks to the end in a checkpoint
  // of that call: what it leaves rejected with no handler fails it (`rejections.ts`).
  for (const text of frames) {
    if (typeof text !== "string") {
      checkpoint(actions.owners.in.get(text.s) ?? null, () => actions.streams.onChunk(text.s, text.bytes));
      continue;
    }
    let m: ToChild;
    try {
      m = JSON.parse(text) as ToChild;
    } catch {
      badStream("a message that is not JSON");
    }
    const t = (m as { t?: unknown } | null)?.t;
    if (t === "call") checkpoint((m as { id: number }).id, () => void calls.call(m as Extract<ToChild, { t: "call" }>));
    else if (t === "reply") {
      const r = m as Extract<ToChild, { t: "reply" }>;
      checkpoint(r.id, () => {
        if (!actions.reply(r)) calls.reply(r);
      });
    } else if (t === "action")
      checkpoint((m as { id: number }).id, () => void actions.call(m as Extract<ToChild, { t: "action" }>));
    else if (t === "cancel")
      checkpoint((m as { id: number }).id, () => actions.cancel(m as Extract<ToChild, { t: "cancel" }>));
    else if (t === "end" || t === "fail" || t === "credit" || t === "stop") {
      const sm = m as Parameters<typeof actions.streams.onMessage>[0];
      const owner = (t === "end" || t === "fail" ? actions.owners.in : actions.owners.out).get(sm.s);
      checkpoint(owner ?? null, () => actions.streams.onMessage(sm));
    } else if (t === "load" || t === "evaluate")
      checkpoint(CHILD_WORK, () => void childWork(handle(m as Extract<ToChild, { t: "load" } | { t: "evaluate" }>)));
    else badStream(`an unknown message (${String(t)})`);
  }
}
// The host closed the stream: it is done with this child.
process.exit(0);

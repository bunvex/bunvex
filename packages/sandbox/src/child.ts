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
import {
  type CodeVersion,
  FunctionExportError,
  InvalidModulesError,
  type LoadOptions,
  MissingEnvironmentVariableError,
  vmExecutor,
} from "@bunvex/server/executor";
import { exportDefault } from "./default-export.ts";
import { FrameReader, frame } from "./frames.ts";
import { PROTOCOL_VERSION, type ToChild, type ToHost, type WireError, type WireLoadOptions } from "./protocol.ts";
import { describeVersion } from "./version.ts";

/** The host's socket (`host.ts`: the 4th entry of the child's stdio). */
const CHANNEL = 3;

/** The child's exit code when the host's stream breaks: not a crash of the app's code. */
export const EXIT_BAD_STREAM = 70;

const out = Bun.file(CHANNEL).writer();
const send = (m: ToHost) => {
  out.write(frame(m));
  void out.flush();
};

/** The versions this child loaded, by request id: PR 3's calls run their functions. */
const versions = new Map<number, CodeVersion>();

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

async function handle(m: ToChild) {
  const started = performance.now();
  try {
    if (m.t === "load") {
      const version = await vmExecutor.load(m.sources, loadOptions(m.options));
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

send({ t: "hello", protocol: PROTOCOL_VERSION, pid: process.pid });

// The host is trusted: its frames are not capped (a push's modules may be large), only checked.
const reader = new FrameReader();
for await (const chunk of Bun.file(CHANNEL).stream()) {
  let texts: string[];
  try {
    texts = reader.push(chunk);
  } catch (e) {
    badStream((e as Error).message);
  }
  for (const text of texts) {
    let m: ToChild;
    try {
      m = JSON.parse(text) as ToChild;
    } catch {
      badStream("a message that is not JSON");
    }
    const t = (m as { t?: unknown } | null)?.t;
    if (t !== "load" && t !== "evaluate") badStream(`an unknown message (${String(t)})`);
    void handle(m);
  }
}
// The host closed the stream: it is done with this child.
process.exit(0);

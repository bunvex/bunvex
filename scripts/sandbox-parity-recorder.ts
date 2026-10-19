// A test preload (`scripts/sandbox-parity-corpus.ts` runs the server's pushed-code suites with it): every load of
// app code and every push-time evaluation the suites make, appended to $SANDBOX_CORPUS_OUT as JSON lines, so the
// function sandbox's parity test can run each one in a child and in-process (STUDY-171 §7.4).
import { appendFileSync } from "node:fs";
import { CodeVersion } from "../packages/server/src/code-version.ts";
import { vmExecutor } from "../packages/server/src/function-executor.ts";

const out = process.env.SANDBOX_CORPUS_OUT;
if (!out) throw new Error("SANDBOX_CORPUS_OUT is not set");
/** The test file that made the call: the first such frame on the stack. */
const suite = () => /packages\/[^\s:()]+\.test\.ts/.exec(new Error().stack ?? "")?.[0] ?? "unknown";
const record = (entry: Record<string, unknown>) =>
  appendFileSync(out, `${JSON.stringify({ suite: suite(), ...entry })}\n`);

const load = CodeVersion.load.bind(CodeVersion);
CodeVersion.load = (sources, opts) => {
  record({
    kind: "load",
    sources,
    options: {
      seed: [...opts.seed],
      timestamp: opts.timestamp,
      env: opts.env ?? {},
      ...(opts.importTimeoutMs === undefined ? {} : { importTimeoutMs: opts.importTimeoutMs }),
      // Not replayable: a test's temporary directory, and a callback (the evaluations below cover it).
      ...(opts.nodeModules === undefined ? {} : { nodeModules: true }),
      ...(opts.onMissingEnv === undefined ? {} : { onMissingEnv: true }),
    },
  });
  return load(sources, opts);
};

const evaluateDefault = vmExecutor.evaluateDefault.bind(vmExecutor);
vmExecutor.evaluateDefault = (source, opts, use) => {
  record({
    kind: "evaluate",
    source,
    use,
    options: {
      seed: [...opts.seed],
      timestamp: opts.timestamp,
      env: opts.env,
      failOnMissingEnv: opts.failOnMissingEnv ?? false,
    },
  });
  return evaluateDefault(source, opts, use);
};

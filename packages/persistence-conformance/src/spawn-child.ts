// The suite's child processes (child.ts, lease-child.ts, batch-child.ts): spawned on the driver module, with the
// suite's lease TTL. Their stderr is passed through and its tail kept, so that a child that dies before it
// prints `start` fails the suite at once with what it printed, instead of leaving the parent waiting forever.
import { type ChildProcess, spawn } from "node:child_process";

/** How much of a child's stderr an error quotes. */
const STDERR_TAIL = 16 * 1024;

export type SuiteChild = {
  proc: ChildProcess;
  /** The exit code (null when killed by a signal), once the process has exited. */
  exited: Promise<number | null>;
  /** Resolves once `started()` holds; rejects if the process exits first, quoting its exit status and stderr. */
  waitForStart(started: () => boolean): Promise<void>;
};

export function spawnChild(script: string, driverModule: string, ttlMs: number): SuiteChild {
  const path = new URL(`./${script}`, import.meta.url).pathname;
  const proc = spawn(process.execPath, [path, driverModule], {
    env: { ...process.env, LEASE_TTL_MS: String(ttlMs) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr!.on("data", (d) => {
    process.stderr.write(d);
    stderr = (stderr + d).slice(-STDERR_TAIL);
  });
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  // Every stdio stream drained too: the last stdout and stderr lines have been read.
  const closed = new Promise<void>((r) => proc.on("close", () => r()));
  const gone = () => proc.exitCode !== null || proc.signalCode !== null;
  return {
    proc,
    exited,
    async waitForStart(started) {
      while (!started()) {
        if (gone()) {
          await closed;
          if (started()) return;
          const status = proc.signalCode ? `signal ${proc.signalCode}` : `code ${proc.exitCode}`;
          throw new Error(
            `the conformance child ${script} exited (${status}) before printing "start"; its stderr:\n${stderr.trimEnd() || "(empty)"}`,
          );
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
}

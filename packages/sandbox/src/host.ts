// The host's side of a sandboxed child (STUDY-171 §7): `SandboxProcess.start()` spawns `child.ts`, waits for its
// handshake, then sends it requests (`load`, `evaluate`) and reads its answers off one socket of its own (fd 3).
//
// A child that dies, sends a message the host cannot use, sends one over the size limit, or does not say hello in
// time is killed (SIGKILL, by its own pid), and every request still waiting on it fails with a `SandboxError` that
// says which. It is not restarted here: the pool that runs calls (STUDY-168 PR 9) replaces dead children.
//
// No OS isolation yet (STUDY-168 PR 8): the child is a plain Bun process with an environment of its own (only the
// knobs it reads, never the server's variables), started in this package's directory so no `bunfig.toml` of the
// server's working directory applies to it.
import { closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { realRuntime } from "@bunvex/core";
import {
  type DefaultExportUse,
  type EvaluateOptions,
  FunctionExportError,
  IMPORT_TIMEOUT_MS,
  InvalidModulesError,
  type LoadOptions,
  MissingEnvironmentVariableError,
  type ModuleSource,
} from "@bunvex/server/executor";
import type { Subprocess } from "bun";
import { evaluatedValue } from "./default-export.ts";
import { FrameReader, FrameTooLargeError, frame } from "./frames.ts";
import {
  BadMessageError,
  type EvaluatedDefault,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseChildMessage,
  type ToChild,
  type ToHost,
  type WireError,
  type WireLoadOptions,
} from "./protocol.ts";
import { type LoadedVersion, loadedVersion } from "./version.ts";

/** The child's entry: this package's `child.ts`, on disk (a compiled executable has none yet: STUDY-171 §7.9). */
export const CHILD_ENTRY = join(import.meta.dir, "child.ts");
/** The child's working directory: no `bunfig.toml` there, so none applies to it. */
const CHILD_CWD = dirname(CHILD_ENTRY);
/** The host's knobs the child's loader reads itself, passed through when set (`code-version.ts`). */
const CHILD_KNOBS = ["MAX_USER_MODULES", "ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS"];
/**
 * How long a child may take to say hello: Convex gives its own Node process 5 s to answer its health check
 * (crates/node_executor/src/local.rs:47-48, 116-126). A cold start here is about 40 ms (STUDY-171 §7.5).
 */
export const HANDSHAKE_TIMEOUT_MS = 5_000;
/** How much of the child's stderr a crash's message quotes. */
const STDERR_TAIL = 2048;

/** Why a child is gone. */
export type SandboxFailure =
  | "crash"
  | "badMessage"
  | "oversize"
  | "handshakeTimeout"
  | "protocol"
  | "stopped"
  | "timeout";

/** A request that failed because its child is gone (not an error of the app's code). */
export class SandboxError extends Error {
  constructor(
    readonly reason: SandboxFailure,
    message: string,
  ) {
    super(`the function sandbox's process ${message}`);
    this.name = "SandboxError";
  }
}

export type SandboxProcessOptions = {
  /** How long the child may take to say hello (default `HANDSHAKE_TIMEOUT_MS`). */
  handshakeTimeoutMs?: number;
  /** The largest frame the child may send (default `MAX_MESSAGE_BYTES`). */
  maxMessageBytes?: number;
  /** The child's entry. Tests only: a child that misbehaves. */
  entry?: string;
};

/**
 * A version loaded in the child, how long the child took (its own clock, request to answer), and the id its calls
 * name it by (the load's request id).
 */
export type ChildLoad = LoadedVersion & { loadMs: number; versionId: number };

/** Where a call's messages go: the call's own loop (`HostCall`), which reads them in its async context. */
export type CallSink = {
  message(m: Extract<ToHost, { t: "op" } | { t: "done" }>): void;
  gone(e: SandboxError): void;
};

type Pending = { resolve: (m: ToHost) => void; reject: (e: unknown) => void };

/** The errors a load or an evaluation throws in-process, rebuilt from the child's (the push maps them alike). */
function hostError(e: WireError): Error {
  switch (e.kind) {
    case "InvalidModules":
      return new InvalidModulesError(e.detail);
    case "FunctionExport":
      return new FunctionExportError(e.message);
    case "MissingEnvironmentVariable":
      return new MissingEnvironmentVariableError(e.variable);
    case "Error": {
      // An error of the server's own code in the child (a limit of the loader): no frames of the app's.
      const error = new Error(e.message);
      error.stack = `Error: ${e.message}`;
      return error;
    }
  }
}

const wireOptions = (o: LoadOptions): WireLoadOptions => ({
  seed: [...o.seed],
  timestamp: o.timestamp,
  env: o.env ?? {},
  importTimeoutMs: o.importTimeoutMs ?? IMPORT_TIMEOUT_MS,
  ...(o.nodeModules === undefined ? {} : { nodeModules: o.nodeModules }),
});

export class SandboxProcess {
  private readonly pending = new Map<number, Pending>();
  private readonly calls = new Map<number, CallSink>();
  private nextId = 0;
  private readonly sink: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
  private dead: SandboxError | null = null;
  private stderrTail = "";
  /** Resolves with the handshake, rejects when the child dies first. */
  private readonly ready: Promise<void>;
  private handshake!: Pending;
  /** The child's reader and stderr loops, done once it is gone. */
  private readonly drained: Promise<unknown>;
  /** From spawn to the child's hello, in ms. */
  spawnToReadyMs = Number.NaN;

  private constructor(
    private readonly proc: Subprocess<"ignore", "inherit", "pipe">,
    private readonly fd: number,
    private readonly opts: Required<Omit<SandboxProcessOptions, "entry">>,
    /** When it was spawned, on the host's monotonic clock. */
    private readonly spawnedAt: number,
  ) {
    this.sink = Bun.file(fd).writer();
    this.ready = new Promise<void>((resolve, reject) => {
      this.handshake = { resolve: () => resolve(), reject };
    });
    // Unhandled until `start` awaits it, which it always does.
    this.ready.catch(() => {});
    const timer = realRuntime.setTimeout(
      () => this.fail("handshakeTimeout", `did not start within ${this.opts.handshakeTimeoutMs} ms`),
      this.opts.handshakeTimeoutMs,
    );
    void this.ready.then(
      () => realRuntime.clearTimeout(timer),
      () => realRuntime.clearTimeout(timer),
    );
    const stderr = this.readStderr();
    const messages = this.readMessages();
    this.drained = Promise.all([stderr, messages]);
    void this.watchExit(stderr);
  }

  /** Spawns a child and waits for its handshake. */
  static async start(options: SandboxProcessOptions = {}): Promise<SandboxProcess> {
    const env: Record<string, string> = {};
    for (const k of CHILD_KNOBS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    const spawnedAt = realRuntime.monotonicNow();
    const proc = Bun.spawn([process.execPath, options.entry ?? CHILD_ENTRY], {
      cwd: CHILD_CWD,
      env,
      stdio: ["ignore", "inherit", "pipe", "pipe"],
    });
    const fd = proc.stdio[3];
    if (typeof fd !== "number") {
      proc.kill("SIGKILL");
      throw new Error("the function sandbox's process has no channel");
    }
    const child = new SandboxProcess(
      proc,
      fd,
      {
        handshakeTimeoutMs: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
        maxMessageBytes: options.maxMessageBytes ?? MAX_MESSAGE_BYTES,
      },
      spawnedAt,
    );
    await child.ready;
    return child;
  }

  get pid(): number {
    return this.proc.pid;
  }

  /** Why the child is gone, once it is. */
  get failure(): SandboxError | null {
    return this.dead;
  }

  /** Loads and analyzes a code version in the child (`CodeVersion.load`'s analysis). */
  async load(sources: ModuleSource[], opts: LoadOptions): Promise<ChildLoad> {
    let versionId = 0;
    const m = await this.request({ t: "load", id: 0, sources, options: wireOptions(opts) }, (id) => {
      versionId = id;
    });
    if (m.t !== "loaded") throw this.unexpected(m);
    let version: LoadedVersion;
    try {
      version = loadedVersion(m.version);
    } catch (e) {
      throw this.fail("badMessage", `sent a message that is not valid: loaded.version: ${(e as Error).message}`);
    }
    return { ...version, loadMs: m.loadMs, versionId };
  }

  /** A standalone module's default export, in the form its use takes (`Executor.evaluateDefault`). */
  async evaluate(source: ModuleSource, opts: EvaluateOptions, use: DefaultExportUse): Promise<EvaluatedDefault> {
    const m = await this.request({
      t: "evaluate",
      id: 0,
      source,
      options: { ...wireOptions(opts), failOnMissingEnv: opts.failOnMissingEnv ?? false },
      use,
    });
    if (m.t !== "evaluated") throw this.unexpected(m);
    return m.export;
  }

  /** `evaluate`, as the push reads the export (`evaluatedValue`). */
  async evaluateDefault(source: ModuleSource, opts: EvaluateOptions, use: DefaultExportUse): Promise<unknown> {
    return evaluatedValue(await this.evaluate(source, opts, use));
  }

  /** A new call's id: its `call`, its `op`s and their `reply`s carry it. */
  newCallId(): number {
    return ++this.nextId;
  }

  /**
   * Opens call `id`: its `op`s and its `done` go to `sink`, until `done` or the child's death. Sends nothing: the
   * caller sends the `call` (`send`).
   */
  openCall(id: number, sink: CallSink) {
    if (this.dead) {
      sink.gone(this.dead);
      return;
    }
    this.calls.set(id, sink);
  }

  /** Sends a message to the child (a `call`, a `reply`); dropped once it is gone. */
  send(m: ToChild) {
    if (this.dead) return;
    try {
      this.sink.write(frame(m));
      Promise.resolve(this.sink.flush()).catch(() => {});
    } catch {}
  }

  /** Kills the child for `reason` (a call's backstop, a message its call cannot use). */
  kill(reason: SandboxFailure, message: string): SandboxError {
    return this.fail(reason, message);
  }

  /** Stops the child (SIGKILL); waiting requests fail. */
  async close(): Promise<void> {
    this.fail("stopped", "was stopped");
    await Promise.all([this.proc.exited, this.drained]);
  }

  private request(m: ToChild, onId?: (id: number) => void): Promise<ToHost> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.nextId;
    onId?.(id);
    return new Promise<ToHost>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // A child that died meanwhile fails the request through `fail` (its exit), not through the write.
      try {
        this.sink.write(frame({ ...m, id }));
        Promise.resolve(this.sink.flush()).catch(() => {});
      } catch {}
    }).then((answer) => {
      if (answer.t === "failed") throw hostError(answer.error);
      return answer;
    });
  }

  private unexpected(m: ToHost): SandboxError {
    return this.fail("protocol", `answered with an unexpected message (${m.t})`);
  }

  private onMessage(m: ToHost) {
    if (m.t === "hello") {
      if (!Number.isNaN(this.spawnToReadyMs)) throw new BadMessageError("a second hello");
      if (m.protocol !== PROTOCOL_VERSION)
        throw this.fail("protocol", `speaks protocol ${m.protocol}, not ${PROTOCOL_VERSION}`);
      this.spawnToReadyMs = realRuntime.monotonicNow() - this.spawnedAt;
      this.handshake.resolve(m);
      return;
    }
    if (Number.isNaN(this.spawnToReadyMs)) throw new BadMessageError(`${m.t} before hello`);
    if (m.t === "op" || m.t === "done") {
      const call = this.calls.get(m.id);
      if (!call) throw new BadMessageError(`a message for no running call (${m.t} ${m.id})`);
      if (m.t === "done") this.calls.delete(m.id);
      call.message(m);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) throw new BadMessageError(`an answer to no request (${m.t} ${m.id})`);
    this.pending.delete(m.id);
    p.resolve(m);
  }

  private async readMessages() {
    const reader = new FrameReader(this.opts.maxMessageBytes);
    try {
      for await (const chunk of Bun.file(this.fd).stream()) {
        if (this.dead) break;
        for (const text of reader.push(chunk)) {
          this.onMessage(parseChildMessage(text));
          if (this.dead) break;
        }
      }
    } catch (e) {
      if (e instanceof FrameTooLargeError) this.fail("oversize", `sent ${e.message}`);
      else if (e instanceof SandboxError) {
        // Already failed.
      } else this.fail("badMessage", `sent a message that is not valid: ${(e as Error).message}`);
    }
  }

  private async readStderr() {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stderr) {
      // The child's stderr is the server's, as an in-process load's is; the tail goes in a crash's message.
      process.stderr.write(chunk);
      this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL);
    }
  }

  private async watchExit(stderr: Promise<unknown>) {
    const code = await this.proc.exited;
    await stderr;
    if (!this.dead) {
      const how = this.proc.signalCode ? `signal ${this.proc.signalCode}` : `exit code ${code}`;
      const tail = this.stderrTail.trim();
      this.fail("crash", `exited unexpectedly (${how})${tail ? `: ${tail}` : ""}`);
    }
    // The socket is ours once read (`Subprocess.stdio`); the child's end is gone with it.
    await this.drained.catch(() => {});
    closeSync(this.fd);
  }

  /** The child is gone: killed if it is not, and every waiting request failed with why. */
  private fail(reason: SandboxFailure, message: string): SandboxError {
    if (this.dead) return this.dead;
    const error = new SandboxError(reason, message);
    this.dead = error;
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGKILL");
    this.handshake.reject(error);
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    for (const c of this.calls.values()) c.gone(error);
    this.calls.clear();
    return error;
  }
}

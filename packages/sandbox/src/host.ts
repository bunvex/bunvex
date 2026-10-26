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
import { closeSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { realRuntime } from "@bunvex/core";
import {
  type DefaultExportUse,
  type EvaluateOptions,
  ExecutorFailure,
  FunctionExportError,
  IMPORT_TIMEOUT_MS,
  InvalidModulesError,
  type LoadOptions,
  MissingEnvironmentVariableError,
  type ModuleSource,
  outOfMemory,
} from "@bunvex/server/executor";
import type { Subprocess } from "bun";
import { evaluatedValue } from "./default-export.ts";
import { chunkHeader, FrameReader, FrameTooLargeError, frame } from "./frames.ts";
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
  type WireThrown,
} from "./protocol.ts";
import { CHUNK_BYTES, Streams, WINDOW_BYTES } from "./streams.ts";
import { type LoadedVersion, loadedVersion } from "./version.ts";

/** The child's entry: this package's `child.ts`, on disk (a compiled executable has none yet: STUDY-171 §7.9). */
export const CHILD_ENTRY = join(import.meta.dir, "child.ts");
/** Set in a child's environment (by the host only): its calls' memory is not capped (`memoryCap`). */
export const NO_MEMORY_CAP = "BUNVEX_SANDBOX_NO_MEMORY_CAP";
/** The child's working directory: no `bunfig.toml` there, so none applies to it. */
const CHILD_CWD = dirname(CHILD_ENTRY);
/** The host's knobs the child's loader reads itself, passed through when set (`code-version.ts`). */
const CHILD_KNOBS = ["MAX_USER_MODULES", "ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS"];
/**
 * How long a child may take to say hello: Convex gives its own Node process 5 s to answer its health check
 * (crates/node_executor/src/local.rs:47-48, 116-126). A cold start here is about 40 ms (STUDY-171 §7.5).
 */
export const HANDSHAKE_TIMEOUT_MS = 5_000;
/** The credit the host's streams to the child start with: the child takes what it is sent as it comes. */
const WINDOW_BYTES_TO_CHILD = WINDOW_BYTES;
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
  | "timeout"
  /** The child stopped itself past its calls' memory cap (`child-memory.ts`). */
  | "oom";

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

/**
 * What a call fails with when its child is gone: past the calls' memory cap, Convex's out-of-memory error (its isolate
 * terminated, uncatchable: STUDY-188 R12); otherwise a system error, Convex's internal error.
 */
export const childGoneError = (e: SandboxError): Error =>
  e.reason === "oom" ? outOfMemory() : new ExecutorFailure(e.message);

export type SandboxProcessOptions = {
  /** How long the child may take to say hello (default `HANDSHAKE_TIMEOUT_MS`). */
  handshakeTimeoutMs?: number;
  /** The largest frame the child may send (default `MAX_MESSAGE_BYTES`). */
  maxMessageBytes?: number;
  /** The child's entry. Tests only: a child that misbehaves. */
  entry?: string;
  /**
   * Whether the child caps its calls' memory (`child-memory.ts`; default true). Tests only: the HTTP response's 100 MiB
   * cap, which a 64 MiB one makes out of reach, as on Convex.
   */
  memoryCap?: boolean;
};

/**
 * A version loaded in the child, how long the child took (its own clock, request to answer), the id its calls
 * name it by (the load's request id), and how many versions the child held then (this one included).
 */
export type ChildLoad = LoadedVersion & { loadMs: number; versionId: number; held: number };

/** Where a call's messages go: the call's own loop (`HostCall`), which reads them in its async context. */
export type CallSink = {
  message(
    m: Extract<ToHost, { t: "op" } | { t: "done" } | { t: "lines" } | { t: "cancelled" } | { t: "response" }>,
  ): void;
  gone(e: SandboxError): void;
};

/** The streams' failures across the wire (set by `host-call.ts`, which knows how errors cross). */
export const streamErrors: {
  thrown: (e: unknown) => WireThrown;
  error: (w: WireThrown) => unknown;
} = {
  thrown: () => ({ k: "host", message: "a stream failed" }),
  error: () => new Error("a stream failed"),
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
  /** The byte streams to and from the child (STUDY-171 §12): every frame of the child's about them is checked. */
  readonly streams: Streams;
  /** What aborts each `fetch` in flight, by call and operation (`abort` from the child). */
  readonly fetches = new Map<string, AbortController>();

  private constructor(
    private readonly proc: Subprocess<"ignore", "inherit", "pipe">,
    private readonly fd: number,
    /** The child's memory channel (`child-memory.ts`): a byte on it, then its death, is its calls' memory cap. */
    private readonly memoryFd: number,
    private readonly opts: Required<Omit<SandboxProcessOptions, "entry" | "memoryCap">>,
    /** When it was spawned, on the host's monotonic clock. */
    private readonly spawnedAt: number,
  ) {
    this.sink = Bun.file(fd).writer();
    this.streams = new Streams(
      {
        message: (m) => this.send(m),
        chunk: (id, bytes) => {
          this.write(chunkHeader(id, bytes.byteLength), false);
          this.write(bytes);
        },
      },
      {
        strict: true,
        initialCredit: WINDOW_BYTES_TO_CHILD,
        thrown: (e) => streamErrors.thrown(e),
        error: (w) => streamErrors.error(w),
      },
    );
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
    // A function's `Date` is UTC, as Convex's (`ensure_utc`) and `bunvex-local-backend`'s (STUDY-171 §10).
    const env: Record<string, string> = { TZ: "UTC" };
    if (options.memoryCap === false) env[NO_MEMORY_CAP] = "1";
    for (const k of CHILD_KNOBS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    const spawnedAt = realRuntime.monotonicNow();
    const proc = Bun.spawn([process.execPath, options.entry ?? CHILD_ENTRY], {
      cwd: CHILD_CWD,
      env,
      // fd 3: the messages, both ways; fd 4: the memory channel, the child's to write (`child-memory.ts`).
      stdio: ["ignore", "inherit", "pipe", "pipe", "pipe"],
    });
    const fd = proc.stdio[3];
    const memoryFd = proc.stdio[4];
    if (typeof fd !== "number" || typeof memoryFd !== "number") {
      proc.kill("SIGKILL");
      throw new Error("the function sandbox's process has no channel");
    }
    const child = new SandboxProcess(
      proc,
      fd,
      memoryFd,
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
    return { ...version, loadMs: m.loadMs, versionId, held: m.held };
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
    this.write(frame(m));
  }

  private write(bytes: Uint8Array, flush = true) {
    if (this.dead) return;
    try {
      this.sink.write(bytes);
      if (flush) Promise.resolve(this.sink.flush()).catch(() => {});
    } catch {}
  }

  /** Call `id` is over for the host (an action cut off and acknowledged): any later message for it is a bad one. */
  closeCall(id: number) {
    this.calls.delete(id);
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
    if (m.t === "op" || m.t === "done" || m.t === "lines" || m.t === "cancelled" || m.t === "response") {
      const call = this.calls.get(m.id);
      if (!call) throw new BadMessageError(`a message for no running call (${m.t} ${m.id})`);
      if (m.t === "done" || m.t === "cancelled") this.calls.delete(m.id);
      call.message(m);
      return;
    }
    if (m.t === "abort") {
      // A fetch that already ended has nothing to abort.
      this.fetches.get(`${m.id}:${m.op}`)?.abort();
      return;
    }
    if (m.t === "end" || m.t === "fail" || m.t === "credit" || m.t === "stop" || m.t === "mark") {
      this.streams.onMessage(m);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) throw new BadMessageError(`an answer to no request (${m.t} ${m.id})`);
    this.pending.delete(m.id);
    p.resolve(m);
  }

  private async readMessages() {
    const reader = new FrameReader(this.opts.maxMessageBytes, CHUNK_BYTES);
    const chunks = Bun.file(this.fd).stream()[Symbol.asyncIterator]();
    try {
      for (;;) {
        let next: IteratorResult<Uint8Array>;
        try {
          next = await chunks.next();
        } catch {
          // The socket broke under the read: on Linux, a child that exits (or closes it) with frames of the host's
          // unread resets it (ECONNRESET), and the host can see that before the exit. No message of the child's is
          // at fault: handled as the end of the stream below.
          next = { done: true, value: undefined };
        }
        if (this.dead) return;
        if (next.done) {
          // The child's end of the socket is gone. The verdict is its exit's (`watchExit`: a crash, with its code and
          // stderr), whichever of the two the host sees first. A child still alive behind it is of no use: killed,
          // it exits too. One that already exited keeps its exit code.
          this.proc.kill("SIGKILL");
          return;
        }
        for (const f of reader.push(next.value)) {
          if (typeof f === "string") this.onMessage(parseChildMessage(f));
          else {
            if (Number.isNaN(this.spawnToReadyMs)) throw new BadMessageError("a chunk before hello");
            this.streams.onChunk(f.s, f.bytes);
          }
          if (this.dead) return;
        }
      }
    } catch (e) {
      if (e instanceof FrameTooLargeError) this.fail("oversize", `sent ${e.message}`);
      else if (e instanceof SandboxError) {
        // Already failed.
      } else this.fail("badMessage", `sent a message that is not valid: ${(e as Error).message}`);
    } finally {
      await chunks.return?.().catch(() => {});
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

  /**
   * Whether the child wrote on its memory channel before it died: it stopped itself past its calls' memory cap. Read
   * once it exited (its end is closed: the read never waits), not while it runs: a reader always waiting on the channel
   * cost each operation of a call a few microseconds (measured, STUDY-188 §X17).
   */
  private stoppedPastCap(): boolean {
    try {
      return readSync(this.memoryFd, new Uint8Array(1)) > 0;
    } catch {
      return false;
    }
  }

  private async watchExit(stderr: Promise<unknown>) {
    const code = await this.proc.exited;
    await stderr;
    if (!this.dead) {
      const oom = this.stoppedPastCap();
      const how = this.proc.signalCode ? `signal ${this.proc.signalCode}` : `exit code ${code}`;
      const tail = this.stderrTail.trim();
      if (oom) this.fail("oom", `stopped itself past its calls' memory cap (${how})`);
      else this.fail("crash", `exited unexpectedly (${how})${tail ? `: ${tail}` : ""}`);
    }
    // The sockets are ours once read (`Subprocess.stdio`); the child's ends are gone with it.
    await this.drained.catch(() => {});
    closeSync(this.fd);
    closeSync(this.memoryFd);
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
    this.streams.failAll(error);
    for (const f of this.fetches.values()) f.abort();
    this.fetches.clear();
    return error;
  }
}

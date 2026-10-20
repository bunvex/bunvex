// An action's call in the child (STUDY-171 §12): the function's own handler, run as the `vm` executor runs an
// action, with a `ctx` whose every operation is the host's.
//
// - **No transaction, no determinism.** The handler runs outside any execution: the real `Date`, `Math.random`,
//   timers and `crypto`, as an action's under `vm`. `process.env` holds the variables at its start, which the call
//   carries (Convex's `get_all`).
// - **`fetch`** is the host's (`isolateFetch`, with its address screen, its proxy, its meters and the action's
//   timeout): the request is described here (its body's bytes as a stream, `streams.ts`), sent as the `fetch`
//   operation, and the host's answer made into a `Response` whose body streams from the host as it is read. An
//   abort of the request's signal is sent as it happens.
// - **`ctx.storage`**: `get` and `store` carry the file's bytes as a stream (or inline, when small), the other methods
//   are operations as a mutation's are. `get` gives a `Blob`, as in-process.
// - **`ctx.vectorSearch`** runs Convex's checks and the filter here, at the app's call, and sends the filter's
//   expression (STUDY-168 §14.1: a recorded filter).
// - **Lines** go to the host as they come (an action's lines stream to the function log), with the next operation
//   when there is one, so the host logs them in order with what the action calls.
// - **The cut-off.** Past the action's timeout the host says `cancel`: every operation waiting is rejected with the
//   timeout, every later one too, and the call's `fetch`es are aborted; the child says `cancelled` and sends nothing
//   more for the call (its lines, its `done`). A child that is too busy to say it in time is killed by the host.
import { checkEnvVarName, setFetchSender, setFetchSignal } from "@bunvex/core";
import {
  ACTION_ENDED_MESSAGE,
  appContext,
  asActionResponse,
  type CodeVersion,
  captureLines,
  inHandleScope,
  type LogLine,
  SpecBlob,
  setServiceCallContext,
  trackedActionTimers,
  vectorSearchFilter,
  withAllEnv,
} from "@bunvex/server/executor";
import { isBytes } from "@bunvex/values";
import { ChildCallBase, rebuiltError, running, type Send, thrownValue } from "./child-call.ts";
import type { WireActionCall, WireLogLine, WireReply, WireReport, WireThrown } from "./protocol.ts";
import { Streams } from "./streams.ts";
import { decode, encode } from "./wire.ts";

/** Bytes up to this size go inline (base64 in the message); larger ones as a stream. */
export const INLINE_BYTES = 64 << 10;

const runningAction = (): ChildActionCall | null => {
  const c = running.getStore();
  return c instanceof ChildActionCall ? c : null;
};

// An action's `fetch` is its host's; its signal is the action's own, aborted at the cut-off. Outside an action (a
// timer an action left behind, once it ended) there is no host to ask.
setFetchSender(() => runningAction()?.fetch ?? noFetch);
setFetchSignal(() => runningAction()?.signal ?? null);
// `getServiceToken` / `getServiceUrl` exist in actions only (STUDY-151 §4).
setServiceCallContext(() => runningAction() !== null);

const noFetch = (() =>
  Promise.reject(new TypeError("fetch is not available outside a running action"))) as unknown as typeof fetch;

/** The child's actions: each call by id, and the byte streams to and from the host. */
export class ActionRuntime {
  readonly streams: Streams;
  private readonly calls = new Map<number, ChildActionCall>();

  constructor(
    private readonly send: Send,
    chunk: (s: number, bytes: Uint8Array) => void,
    private readonly versions: Map<number, CodeVersion>,
  ) {
    this.streams = new Streams(
      { message: (m) => send(m), chunk },
      { strict: false, initialCredit: 0, thrown: thrownValue, error: (w) => errorFromWire(w) },
    );
  }

  async call(m: WireActionCall) {
    const call = new ChildActionCall(m, this.send, this.streams);
    this.calls.set(m.id, call);
    try {
      const f = this.versions.get(m.version)?.functions.get(m.fn);
      if (!f || f.kind !== "action") throw new Error(`the function ${m.fn} is not an action of this version`);
      await call.run(f.handler as (ctx: unknown, args: unknown) => unknown);
    } finally {
      call.whenAnswered(() => this.calls.delete(m.id));
      call.ended();
    }
  }

  /** The host's answer to an action's operation: false when the call is not an action's. */
  reply(m: WireReply): boolean {
    const call = this.calls.get(m.id);
    if (!call) return false;
    call.reply(m);
    return true;
  }

  /** The host cut an action off (its timeout): one that already ended has nothing to cut. */
  cancel(m: { id: number; error: WireThrown }) {
    this.calls.get(m.id)?.cancel(m.error);
  }
}

/** An error from the wire (a stream's failure, the cut-off's timeout). */
function errorFromWire(w: WireThrown): unknown {
  if (w.k === "error") return rebuiltError(w);
  if (w.k === "host") return new Error(w.message);
  return new Error("the host failed a stream");
}

/** The `RequestInit` fields the host's `fetch` reads besides the method, headers and body (Bun's own are dropped). */
const INIT_FIELDS = [
  "redirect",
  "referrer",
  "referrerPolicy",
  "mode",
  "credentials",
  "cache",
  "integrity",
  "keepalive",
  "priority",
  "duplex",
] as const;

/** A response as the host describes it. */
type WireResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  url: string;
  redirected: boolean;
  type: string;
  body: number | null;
};

/** A file as the host or the child describes it: its type and size, its bytes inline (`b`) or as a stream (`s`). */
export type WireFile = { type: string; size: number; b?: ArrayBuffer; s?: number };

class ChildActionCall extends ChildCallBase {
  private readonly lines: WireLogLine[] = [];
  private flushing = false;
  /** Set once the host cut the action off: what every operation now throws. */
  private cut: unknown = null;
  private done = false;
  private lastOp = 0;
  /** Operations started whose arguments are still being made (`later`): `done` waits for them. */
  private readonly preparing = new Set<Promise<void>>();
  private readonly cutOff = new AbortController();
  /** The call's `fetch`: the host's. */
  readonly fetch = ((input: unknown, init?: RequestInit) => this.bridgeFetch(input, init)) as unknown as typeof fetch;

  constructor(
    private readonly m: WireActionCall,
    send: Send,
    private readonly streams: Streams,
  ) {
    super(m.id, send);
  }

  get signal(): AbortSignal {
    return this.cutOff.signal;
  }

  protected report(): WireReport {
    return { ran: 0, time: false, env: [], links: [], lines: this.lines.splice(0) };
  }

  protected override before() {
    if (this.cut !== null) throw this.cut;
    if (this.done) throw new Error(ACTION_ENDED_MESSAGE);
  }

  protected override sendOp(op: number, name: string, args: unknown[]) {
    this.lastOp = op;
    super.sendOp(op, name, args);
  }

  /** A console line, sent as it comes: with the call's next message, or on its own once this turn's code is done. */
  logLine(l: LogLine) {
    if (this.cut !== null || this.done) return;
    this.lines.push([l.level, l.messages, l.isTruncated, l.timestamp]);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      if (this.lines.length && this.cut === null && !this.done)
        this.send({ t: "lines", id: this.id, lines: this.lines.splice(0) });
    });
  }

  /** The host cut the action off: everything waiting fails with its timeout, and the host hears no more of it. */
  cancel(w: WireThrown) {
    if (this.cut !== null || this.done) return;
    const error = errorFromWire(w);
    this.cut = error;
    this.lines.length = 0;
    this.endTimers();
    this.send({ t: "cancelled", id: this.id });
    this.cutOff.abort(error);
    for (const [op, waiting] of [...this.waiting]) {
      this.waiting.delete(op);
      waiting.reject(error);
    }
  }

  /** The operations the action left without their answer: the host counts them as unawaited, as Convex does. */
  private unanswered(): number[] {
    return [...this.waiting.keys()];
  }

  /** Clears the timers its code set (none before it ran). */
  private endTimers: () => void = () => {};

  /** The handler settled (or the call could not start): nothing more is sent for it, and its timers are cleared. */
  ended() {
    this.done = true;
    this.endTimers();
  }

  private ctx() {
    const op = (name: string, ...args: unknown[]) => this.op(name, args);
    const methods = (prefix: string, names: readonly string[]) =>
      Object.fromEntries(names.map((n) => [n, async (...args: unknown[]) => op(prefix, n, ...args)]));
    // A callee's error reaches the app through its context's view (`appContext`), which gives it the app's frames
    // where it awaited, as under `vm`.
    const nested = (name: string) => async (ref: unknown, args?: unknown) => this.op(name, [ref, args]);
    const storage = {
      ...methods("storage", ["getUrl", "getMetadata", "generateUploadUrl", "delete"]),
      get: async (storageId: unknown) => this.storageGet(storageId),
      store: async (blob: unknown, opts?: unknown) => this.storageStore(blob, opts),
    };
    return {
      auth: { getUserIdentity: async () => op("auth.getUserIdentity") },
      runQuery: nested("runQuery"),
      runMutation: nested("runMutation"),
      runAction: nested("runAction"),
      scheduler: methods("scheduler", ["runAfter", "runAt", "cancel"]),
      storage,
      rooms: methods("rooms", ["broadcast", "members"]),
      presence: methods("presence", ["list"]),
      vectorSearch: async (tableName: string, indexName: string, query: Record<string, unknown>) => {
        this.before();
        const filter = vectorSearchFilter(tableName, indexName, query as never);
        const q: Record<string, unknown> = { vector: query.vector };
        if (query.limit !== undefined) q.limit = query.limit;
        if (filter !== undefined) q.filter = filter;
        return op("vectorSearch", tableName, indexName, q);
      },
      meta: methods("meta", this.m.meta),
    };
  }

  async run(handler: (ctx: unknown, args: unknown) => unknown) {
    const args = decode(this.m.args, false);
    const ctx = this.ctx();
    const all = this.m.env ? Object.fromEntries(this.m.env) : null;
    const read = (name: string) => {
      checkEnvVarName(name);
      return all && Object.hasOwn(all, name) ? all[name] : undefined;
    };
    const body = () => {
      const call = () => handler(appContext(handler, ctx), args);
      return all ? withAllEnv(all, read, call) : call();
    };
    let message: Parameters<Send>[0];
    // What the handler started is sent before its answer (`later`).
    const sent = async () => {
      while (this.preparing.size) await Promise.all([...this.preparing]);
    };
    try {
      // Its code's timers are the action's: cleared when it ends (STUDY-77 §7), as the engine clears a `vm` action's.
      const run = trackedActionTimers(() =>
        running.run(this, () =>
          captureLines(
            (line) => this.logLine(line),
            () =>
              inHandleScope(
                { db: null, create: (ref: unknown) => this.op("createFunctionHandle", [ref]) } as never,
                body,
              ),
          ),
        ),
      );
      this.endTimers = run.end;
      const value = await run.value;
      await sent();
      message = {
        t: "done",
        id: this.id,
        ok: true,
        value: encode(value),
        report: this.report(),
        pending: this.unanswered(),
      };
    } catch (e) {
      await sent();
      message = {
        t: "done",
        id: this.id,
        ok: false,
        error: this.thrown(e),
        report: this.report(),
        pending: this.unanswered(),
      };
    }
    if (this.cut === null && !this.done) this.send(message);
  }

  // ------------------------------------------------------------------ storage

  private async storageGet(storageId: unknown): Promise<Blob | null> {
    const d = (await this.op("storage.get", [storageId])) as WireFile | null;
    if (d === null) return null;
    const parts: (ArrayBuffer | Uint8Array)[] = [];
    if (d.b !== undefined) parts.push(d.b);
    else if (d.s !== undefined) for await (const c of this.streams.receive(d.s)) parts.push(c);
    return new SpecBlob(parts, { type: d.type });
  }

  private storageStore(blob: unknown, opts: unknown): Promise<unknown> {
    // What is not a `Blob` gets the host's own refusal.
    if (!(blob instanceof Blob)) return this.op("storage", ["store", blob, opts]);
    return this.later("storage.store", async () => [await this.file(blob), opts]);
  }

  /**
   * An operation whose arguments take a while to make (a file's bytes): started at the app's call, sent once they are
   * made, and the action's `done` waits until it is sent, so the host runs it (and counts it as pending if the action
   * did not await it) as the engine runs what an action started in-process.
   */
  private later(name: string, args: () => Promise<unknown[]>, sent?: (op: number) => void): Promise<unknown> {
    this.before();
    let made!: () => void;
    const ready = new Promise<void>((resolve) => (made = resolve));
    this.preparing.add(ready);
    void ready.then(() => this.preparing.delete(ready));
    return args().then(
      (a) => {
        try {
          const answer = this.op(name, a);
          sent?.(this.lastOp);
          return answer;
        } finally {
          made();
        }
      },
      (e) => {
        made();
        throw e;
      },
    );
  }

  /** A `Blob` for the host: its type and size, its bytes inline or as a stream. */
  private async file(blob: Blob): Promise<WireFile> {
    if (blob.size <= INLINE_BYTES) return { type: blob.type, size: blob.size, b: await blob.arrayBuffer() };
    return { type: blob.type, size: blob.size, s: this.streams.send(blob.stream()) };
  }

  // ------------------------------------------------------------------ fetch

  private async bridgeFetch(input: unknown, init?: RequestInit): Promise<Response> {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    let op = 0;
    const answer = this.later(
      "fetch",
      async () => {
        const request: Record<string, unknown> = {};
        if (input instanceof Request) {
          request.request = {
            url: input.url,
            method: input.method,
            headers: [...input.headers],
            redirect: input.redirect,
            body: input.body === null ? null : { kind: "stream", s: this.streams.send(input.body) },
          };
        } else request.input = String(input);
        if (init !== undefined && init !== null) request.init = await this.describeInit(init);
        if (signal?.aborted) request.aborted = true;
        return [request];
      },
      (n) => {
        op = n;
      },
    );
    const onAbort = () => {
      if (this.cut === null && !this.done) this.send({ t: "abort", id: this.id, op });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let d: WireResponse;
    try {
      d = (await answer) as WireResponse;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (d.body !== null && signal && !signal.aborted) {
      // An abort while the body is read fails the read, as the host's response's does.
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const body = d.body === null ? null : this.streams.receive(d.body);
    const response = new Response(body, { status: d.status, statusText: d.statusText, headers: d.headers });
    // Its reads fail as the host's response's would have (`isolateFetch`'s), naming its URL.
    return asActionResponse(
      response,
      { url: d.url, signal: signal ? AbortSignal.any([signal, this.signal]) : this.signal },
      d,
    );
  }

  /** `init` as the host rebuilds it: its method, headers, body and the web's fields. */
  private async describeInit(init: RequestInit): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (init.method !== undefined) out.method = String(init.method);
    if (init.headers !== undefined)
      out.headers = init.headers instanceof Headers ? [...init.headers] : (init.headers as unknown);
    if ("body" in init) out.body = await this.describeBody(init.body);
    for (const k of INIT_FIELDS) {
      const v = (init as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  private async describeBody(body: unknown): Promise<unknown> {
    if (body === undefined) return { kind: "undefined" };
    if (body === null) return null;
    if (typeof body === "string") return { kind: "text", text: body };
    if (body instanceof ReadableStream) return { kind: "stream", s: this.streams.send(body) };
    if (body instanceof Blob) return { kind: "blob", file: await this.file(body) };
    // The app's `ArrayBuffer` is its context's, not this realm's: told by its slot, not by `instanceof`.
    if (isBytes(body) || ArrayBuffer.isView(body)) {
      const bytes = ArrayBuffer.isView(body)
        ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
        : new Uint8Array(body as ArrayBuffer);
      return { kind: "bytes", file: await this.file(new Blob([bytes])) };
    }
    if (body instanceof URLSearchParams) return { kind: "params", text: body.toString() };
    if (body instanceof FormData) {
      const entries: unknown[] = [];
      for (const [name, value] of body as unknown as Iterable<[string, string | File]>) {
        if (typeof value === "string") entries.push([name, value]);
        else entries.push([name, { file: await this.file(value), name: value.name, lastModified: value.lastModified }]);
      }
      return { kind: "form", entries };
    }
    return { kind: "text", text: String(body) };
  }
}

export type { ChildActionCall };

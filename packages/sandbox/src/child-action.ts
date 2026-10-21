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
// - **HTTP actions** (STUDY-168 PR 6) run as actions whose argument is a `Request` made from the host's (its body
//   streamed from the host as it is read, its signal aborted when the client leaves) and whose answer is the response,
//   read as the server reads one in-process (`runHttpAction`): its headers first, then a body of known length whole, or
//   a stream checked for a failure in the handler's turn (`readsAhead`, the server's own) and then streamed, its chunks
//   checked as the server checks them (`bodyChunk`). The call goes on until the body has been handed over: the code
//   making its chunks may call `ctx`, log, `fetch`, and what it leaves rejected with no handler ends the body there.
import { checkEnvVarName, setFetchSender, setFetchSignal } from "@bunvex/core";
import {
  ACTION_ENDED_MESSAGE,
  appContext,
  asActionResponse,
  bodyChunk,
  bodyLength,
  type CodeVersion,
  captureLines,
  HTTP_ACTION_RESPONSE_LIMIT,
  inHandleScope,
  type LogLine,
  readsAhead,
  SpecBlob,
  setActionTimerCallback,
  setServiceCallContext,
  trackedActionTimers,
  typedBlob,
  vectorSearchFilter,
  withAllEnv,
} from "@bunvex/server/executor";
import { isBytes } from "@bunvex/values";
import { ChildCallBase, rebuiltError, running, type Send, thrownValue } from "./child-call.ts";
import type {
  ToHost,
  WireActionCall,
  WireHttpCall,
  WireLogLine,
  WireReply,
  WireReport,
  WireResponseBody,
  WireThrown,
} from "./protocol.ts";
import { checkpoint, checkpointOf, checkSoon, track, untrack } from "./rejections.ts";
import { MARK, Streams } from "./streams.ts";
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
// A timer's callback resumes its action's code from a macrotask of Bun's: run in a checkpoint of that action, so what
// it leaves rejected with no handler fails it (`rejections.ts`). Its async context is the action's (Bun keeps it).
setActionTimerCallback(
  (callback) =>
    function (this: unknown, ...args: unknown[]) {
      let out: unknown;
      checkpoint(runningAction()?.id ?? null, () => {
        out = callback.apply(this, args);
      });
      return out;
    },
);

const noFetch = (() =>
  Promise.reject(new TypeError("fetch is not available outside a running action"))) as unknown as typeof fetch;

/** Which call each stream is for, by its id: the host's (`in`, its chunks and their end) and the child's (`out`). */
export type StreamOwners = { in: Map<number, number>; out: Map<number, number> };

/** The child's actions: each call by id, and the byte streams to and from the host. */
export class ActionRuntime {
  readonly streams: Streams;
  readonly owners: StreamOwners = { in: new Map(), out: new Map() };
  private readonly calls = new Map<number, ChildActionCall>();

  constructor(
    private readonly send: Send,
    chunk: (s: number, bytes: Uint8Array) => void,
    private readonly versions: Map<number, CodeVersion>,
    /** Sends a stream's end or mark, flushed with what follows it (or at the end of the turn). */
    later: Send = send,
  ) {
    this.streams = new Streams(
      { message: (m) => (m.t === "end" || m.t === "mark" ? later(m) : send(m)), chunk },
      {
        strict: false,
        initialCredit: 0,
        thrown: (e) => (e instanceof WireFailure ? e.wire : thrownValue(e)),
        error: (w) => errorFromWire(w),
      },
    );
  }

  async call(m: WireActionCall) {
    const call = new ChildActionCall(m, this.send, this.streams, this.owners, () =>
      call.whenAnswered(() => {
        this.calls.delete(m.id);
        call.forgetStreams();
      }),
    );
    this.calls.set(m.id, call);
    const f = this.versions.get(m.version)?.functions.get(m.fn);
    if (f?.kind !== "action") call.failToStart(new Error(`the function ${m.fn} is not an action of this version`));
    else await call.run(f.handler as (ctx: unknown, args: unknown) => unknown);
  }

  /** An HTTP action's call: the handler of the route the host's router matched, with the request. */
  async http(m: WireHttpCall) {
    const call = new ChildActionCall(m, this.send, this.streams, this.owners, () =>
      call.whenAnswered(() => {
        this.calls.delete(m.id);
        call.forgetStreams();
      }),
    );
    this.calls.set(m.id, call);
    const version = this.versions.get(m.version);
    const handler = version ? httpHandlerOf(version, m.route) : null;
    if (!handler) call.failToStart(new Error(`the route ${m.route.join(" ")} is not an HTTP action of this version`));
    else await call.runHttp(handler);
  }

  /** The HTTP action's client left. */
  disconnect(m: { id: number; reason: WireThrown }) {
    this.calls.get(m.id)?.disconnect(m.reason);
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

/** The handler of a version's route, as its router lists it (`getRoutes`: what the host's stand-in was made from). */
function httpHandlerOf(version: CodeVersion, [method, path]: [string, string]) {
  const route = version.router?.getRoutes().find(([p, m]) => p === path && m === method);
  const handler = (route?.[2] as { _handler?: unknown } | undefined)?._handler;
  return typeof handler === "function" ? (handler as (ctx: unknown, request: Request) => unknown) : null;
}

/** A failure already described for the wire (an unhandled rejection's, as thrown), ending a body stream. */
class WireFailure {
  constructor(readonly wire: WireThrown) {}
}

/** A chunk of any realm's bytes as a view of them (the app's `ArrayBuffer` is its context's). */
const viewOf = (b: ArrayBuffer | ArrayBufferView): Uint8Array =>
  ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);

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
  /** Set once the action ended (answered, cut off, or failed of a rejection): nothing more is sent for it. */
  private done = false;
  /** Its answer once the handler settled, sent once the checkpoint it settled in was checked (`checked`). */
  private outcome: ToHost | null = null;
  /** The streams it took or sent (`StreamOwners`), forgotten with it. */
  private readonly streamIds: { in: number[]; out: number[] } = { in: [], out: [] };
  private lastOp = 0;
  /** Operations started whose arguments are still being made (`later`): `done` waits for them. */
  private readonly preparing = new Set<Promise<void>>();
  private readonly cutOff = new AbortController();
  /** The call's `fetch`: the host's. */
  readonly fetch = ((input: unknown, init?: RequestInit) => this.bridgeFetch(input, init)) as unknown as typeof fetch;
  /** An HTTP action's: its request's signal, aborted when the client leaves. */
  private readonly clientGone = new AbortController();
  /** An HTTP action's request body (the host's stream), stopped at its end if nobody read it. */
  private requestBody: number | null = null;
  private req: Request | null = null;
  /**
   * An HTTP action's response body (its stream to the host), which waits for the head to be sent (`opened`): true
   * then, false if the call ended before.
   */
  private responseBody: { s: number; opened: Promise<boolean>; open: (sent: boolean) => void } | null = null;
  /** Set once an HTTP action's head was sent: its body streams (a rejection then ends the body, not the run). */
  private streaming = false;
  /** Ends the body's read of the app's stream with an unhandled rejection's failure, as thrown. */
  private bodyFailed: ((w: WireFailure) => void) | null = null;

  constructor(
    private readonly m: WireActionCall | WireHttpCall,
    send: Send,
    private readonly streams: Streams,
    private readonly owners: StreamOwners,
    private readonly forget: () => void,
  ) {
    super(m.id, send);
    track(m.id, this);
  }

  /** The host's stream `s`, read by this action. */
  private receive(s: number): ReadableStream<Uint8Array> {
    this.owners.in.set(s, this.id);
    this.streamIds.in.push(s);
    return this.streams.receive(s);
  }

  /** `source` sent to the host as this action's stream. */
  private sendStream(source: Parameters<Streams["send"]>[0], onStop?: () => void, onEnd?: () => void): number {
    const s = this.streams.send(source, onStop, onEnd);
    this.owners.out.set(s, this.id);
    this.streamIds.out.push(s);
    return s;
  }

  forgetStreams() {
    for (const s of this.streamIds.in) this.owners.in.delete(s);
    for (const s of this.streamIds.out) this.owners.out.delete(s);
  }

  /**
   * The handler settled: the answer goes at the end of the checkpoint it settled in, once Bun reported what that
   * drain left rejected with no handler (Convex checks after each microtask checkpoint, the last one included:
   * `environment/action/mod.rs`). Settled outside a checkpoint of its own, it checks in one of its own next.
   */
  private settled(message: ToHost) {
    if (this.cut !== null || this.done) return;
    this.outcome = message;
    if (checkpointOf() !== this.id) checkSoon(this.id);
  }

  checked() {
    const message = this.outcome;
    if (message === null || this.cut !== null || this.done) return;
    this.outcome = null;
    this.send(message);
    if (message.t !== "response") return this.ended();
    // An HTTP action's response: its body streams now, and its end ends the call; with none to stream, it ends here.
    this.streaming = true;
    if (this.responseBody) this.responseBody.open(true);
    else void this.finishHttp();
  }

  unhandled(reason: unknown) {
    if (this.cut !== null || this.done) return;
    if (this.streaming) {
      // After the response's head: the body ends there, with the error, as Convex's run ends with its termination
      // error once the response has started (`run_http_action`); the call ends as the body does.
      this.terminated = true;
      const failure = new WireFailure(this.rejected(reason));
      if (this.responseBody) this.streams.failOutgoing(this.responseBody.s, failure.wire);
      this.bodyFailed?.(failure);
      return;
    }
    // Convex terminates the isolate there: the action fails with that error, the operations it had not taken the
    // answer of are its unawaited ones, and no more of its code runs.
    this.terminated = true;
    this.outcome = null;
    this.send({
      t: "done",
      id: this.id,
      ok: false,
      error: this.rejected(reason),
      report: this.report(),
      pending: this.unanswered(),
    });
    this.ended();
  }

  /** The HTTP action's client left: its request's signal aborts. */
  disconnect(w: WireThrown) {
    if (!this.clientGone.signal.aborted) this.clientGone.abort(errorFromWire(w));
  }

  /** The call could not start (a broken host's): it fails with `e`. */
  failToStart(e: unknown) {
    this.send({ t: "done", id: this.id, ok: false, error: this.thrown(e), report: this.report(), pending: [] });
    this.ended();
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
    this.outcome = null;
    untrack(this.id);
    this.forget();
    this.lines.length = 0;
    this.endTimers();
    this.closeHttp();
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

  /** The action ended: nothing more is sent for it, and its timers are cleared. */
  private ended() {
    this.done = true;
    untrack(this.id);
    this.forget();
    this.endTimers();
    this.closeHttp();
  }

  /**
   * An HTTP action's streams once it ended: a response body that never got its head is dropped here, unsent (the host
   * never opened it); a request body nobody read is stopped.
   */
  private closeHttp() {
    if (this.responseBody) {
      this.streams.onMessage({ t: "stop", s: this.responseBody.s });
      this.responseBody.open(false);
      this.responseBody = null;
    }
    // A body the app (or its `formData()`) is reading goes on, as in-process.
    if (this.requestBody !== null && !this.req?.bodyUsed && !this.req?.body?.locked) {
      this.streams.stopIncoming(this.requestBody);
    }
    this.requestBody = null;
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
    const args = decode((this.m as WireActionCall).args, false);
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
    this.settled(message);
  }

  // ------------------------------------------------------------------ HTTP actions

  /** The HTTP action's handler, run as an action is, with the request; then its response, as the server reads it. */
  async runHttp(handler: (ctx: unknown, request: Request) => unknown) {
    const ctx = this.ctx();
    const all = this.m.env ? Object.fromEntries(this.m.env) : null;
    const read = (name: string) => {
      checkEnvVarName(name);
      return all && Object.hasOwn(all, name) ? all[name] : undefined;
    };
    const sent = async () => {
      while (this.preparing.size) await Promise.all([...this.preparing]);
    };
    // The response is read where the handler ran (its async context: its lines, its `ctx`, its `fetch`), so the code
    // that makes the body's chunks runs as the handler's own.
    const body = async () => {
      const request = this.request();
      const call = async () => this.respond(await handler(appContext(handler, ctx), request));
      return all ? withAllEnv(all, read, call) : call();
    };
    let message: ToHost;
    try {
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
      message = await run.value;
      await sent();
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
    this.settled(message);
  }

  /** The request the handler gets: the host's head, its body streamed from the host as it is read. */
  private request(): Request {
    const r = (this.m as WireHttpCall).request;
    if (r.body !== null) this.requestBody = r.body;
    const body = r.body === null ? null : this.receive(r.body);
    const request = new Request(r.url, {
      method: r.method,
      headers: r.headers,
      body,
      signal: this.clientGone.signal,
      ...(body === null ? {} : { duplex: "half" }),
    } as RequestInit);
    typedBlob(request);
    this.req = request;
    // A multipart body is parsed by the host, as Convex's runtime parses it with an operation (`form/parseMultiPart`,
    // npm-packages/udf-runtime/src/21_formdata.ts), pending as `formData` until it settles (`trackedFormData`).
    if (/^multipart\/form-data\b/i.test(request.headers.get("content-type") ?? "")) {
      const own = request.formData.bind(request) as () => Promise<unknown>;
      Object.defineProperty(request, "formData", { value: () => this.formData(request, own), configurable: true });
    }
    return request;
  }

  private formData(request: Request, own: () => Promise<unknown>): Promise<unknown> {
    // What Bun refuses (a body read already, or none) it refuses here as in-process.
    if (request.bodyUsed || request.body === null) return own();
    const type = request.headers.get("content-type") ?? "";
    const stream = request.body;
    return this.later("formData", async () => [type, { s: this.sendStream(stream) }]).then(async (entries) => {
      const form = new FormData();
      for (const [name, v] of entries as [string, string | { file: WireFile; name: string; lastModified: number }][]) {
        if (typeof v === "string") form.append(name, v);
        else
          form.append(
            name,
            new File(await this.fileParts(v.file), v.name, { type: v.file.type, lastModified: v.lastModified }),
          );
      }
      return form;
    });
  }

  /**
   * The response, as the server reads one in-process (`runHttpAction`): not a `Response` (the server refuses it); its
   * headers before its body; a body of known length (`bodyLength`) whole; a stream checked for a failure in the
   * handler's turn, which fails the run, then streamed.
   */
  private async respond(response: unknown): Promise<ToHost> {
    if (!(response instanceof Response))
      return {
        t: "done",
        id: this.id,
        ok: true,
        value: encode(null),
        report: this.report(),
        pending: this.unanswered(),
      };
    const head = { status: response.status, statusText: response.statusText, headers: [...response.headers] };
    const stream = response.body;
    let body: WireResponseBody = null;
    if (stream) {
      const length = response.bodyUsed ? undefined : bodyLength(response);
      if (length !== undefined) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        body =
          bytes.byteLength <= INLINE_BYTES
            ? { kind: "bytes", b: encode(bytes.buffer as ArrayBuffer), length }
            : {
                kind: "whole",
                s: this.openBody(() => this.whole(bytes)),
                length,
                gather: bytes.byteLength > HTTP_ACTION_RESPONSE_LIMIT,
              };
      } else {
        const reader = readsAhead(stream);
        const early = await reader.failedEarly();
        if (early) throw early.error;
        // Stopped by the host (the client gone, a HEAD request), the app's stream is cancelled at once, as in-process.
        body = {
          kind: "stream",
          s: this.openBody(
            () => this.chunks(reader),
            () => void reader.cancel().catch(() => {}),
          ),
        };
      }
    }
    return { t: "response", id: this.id, ...head, body };
  }

  /**
   * `source` as the response's body, held until its head is sent (the host opens it then). Once its end (or failure)
   * is sent, the call ends: the host hears the body's end and the call's `done` together, as the server in-process sees
   * a body that ends with its last chunk at once.
   */
  private openBody(source: () => AsyncGenerator<Uint8Array | typeof MARK>, onStop?: () => void): number {
    let open!: (sent: boolean) => void;
    const opened = new Promise<boolean>((resolve) => (open = resolve));
    const body = { s: 0, opened, open };
    this.responseBody = body;
    body.s = this.sendStream(source(), onStop, () => void this.finishHttp());
    return body.s;
  }

  private async *whole(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
    if (!(await this.responseBody!.opened)) return;
    for (let i = 0; i < bytes.byteLength; i += 1 << 20) yield bytes.subarray(i, i + (1 << 20));
  }

  /**
   * The app's body, read as the server reads it in-process (`meteredBody`): what it has is sent as its credit allows,
   * a chunk that is not bytes ends it with the server's error, its own failure ends it with its error. Stopped by the
   * host (the client gone, a HEAD request), it is cancelled, as in-process.
   */
  private async *chunks(reader: ReturnType<typeof readsAhead>): AsyncGenerator<Uint8Array | typeof MARK> {
    if (!(await this.responseBody!.opened)) return;
    const failed = new Promise<WireFailure>((resolve) => (this.bodyFailed = resolve));
    let ended = false;
    // The 100 MiB limit is the app's chunks': the first that would cross it is dropped, and every one after, as the
    // server drops them (`meteredBody`); the host hears where (a mark), and its server logs it.
    let sent = 0;
    let over = false;
    try {
      for (;;) {
        const r = await Promise.race([reader.read(), failed]);
        if (r instanceof WireFailure) {
          ended = true;
          throw r;
        }
        if (r.done) {
          ended = true;
          return;
        }
        const chunk = bodyChunk(r.value);
        if (chunk === null || over) continue;
        if (sent + chunk.byteLength > HTTP_ACTION_RESPONSE_LIMIT) {
          over = true;
          yield MARK;
          continue;
        }
        sent += chunk.byteLength;
        yield viewOf(chunk);
      }
    } catch (e) {
      ended = true;
      throw e;
    } finally {
      if (!ended) void reader.cancel().catch(() => {});
    }
  }

  /**
   * The response's body was handed over (or there was none): the call ends, with what it left pending. Its `done`
   * flushes what the body's end left unflushed (`child.ts`).
   */
  private async finishHttp() {
    while (this.preparing.size) await Promise.all([...this.preparing]);
    if (this.done || this.cut !== null) return;
    this.responseBody = null;
    this.bodyFailed = null;
    this.send({
      t: "done",
      id: this.id,
      ok: true,
      value: encode(null),
      report: this.report(),
      pending: this.unanswered(),
    });
    this.ended();
  }

  /** A file's bytes as the host sent them, inline or as a stream. */
  private async fileParts(d: WireFile): Promise<(ArrayBuffer | Uint8Array)[]> {
    const parts: (ArrayBuffer | Uint8Array)[] = [];
    if (d.b !== undefined) parts.push(d.b);
    else if (d.s !== undefined) for await (const c of this.receive(d.s)) parts.push(c);
    return parts;
  }

  // ------------------------------------------------------------------ storage

  private async storageGet(storageId: unknown): Promise<Blob | null> {
    const d = (await this.op("storage.get", [storageId])) as WireFile | null;
    if (d === null) return null;
    const parts: (ArrayBuffer | Uint8Array)[] = [];
    if (d.b !== undefined) parts.push(d.b);
    else if (d.s !== undefined) for await (const c of this.receive(d.s)) parts.push(c);
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
    return { type: blob.type, size: blob.size, s: this.sendStream(blob.stream()) };
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
            body: input.body === null ? null : { kind: "stream", s: this.sendStream(input.body) },
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
    const body = d.body === null ? null : this.receive(d.body);
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
    if (body instanceof ReadableStream) return { kind: "stream", s: this.sendStream(body) };
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

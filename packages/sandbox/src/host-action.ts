// An action's call on the host (STUDY-171 §12): the stand-in the engine runs as the action's handler, and the
// operations it answers with the action's real `ctx`.
//
// The engine runs the stand-in as it runs any action (`Functions.runAction`): under its permit, its timeout, its
// environment, its handle scope, its function log entry. So each operation the child sends runs on the action's
// `ctx` in that async context: `runQuery` / `runMutation` / `runAction`, the scheduler, storage, vector search, rooms,
// `fetch` (the host's own, through `isolateFetch`, the address screen and the proxy, metered and aborted with the
// action), each counted as pending until it settles (the unawaited-operations warning) as under `vm`.
//
// - **Bytes** cross as streams (`streams.ts`): a `fetch`'s request and response bodies as they are read, a stored
//   file's in 1 MiB chunks; small ones inline.
// - **The cut-off, then a kill.** Past the action's timeout the engine fails the action and cuts its `ctx` off, as
//   under `vm`; the host also tells the child (`cancel`), which cuts the handler off from its operations and its
//   `fetch` and says `cancelled`. A child that does not answer within `CUT_OFF_GRACE_MS` is running JavaScript that
//   never yields: it is killed (STUDY-168 §10.3), and with it the version's other calls (one child per version, until
//   STUDY-168's PR 9 pool).
// - **HTTP actions** (STUDY-168 PR 6) are actions whose argument is the request and whose answer is a response: the
//   request's body streams to the child as the handler reads it, and the response comes back as its head and its body
//   (`runHttp`). A body of known length is gathered here before the response is handed on, so the server sends it as
//   it sends one made in-process (its `content-length`, Bun's framing); a stream streams, and the call goes on while it
//   does: the code that makes its chunks may still call `ctx`.

import { realRuntime } from "@bunvex/core";
import {
  BODY_OVER_LIMIT,
  createFunctionHandle,
  currentActionSignal,
  currentAllEnv,
  currentPendingOps,
  ExecutorFailure,
  SpecBlob,
  trackedOperation,
  withBodyLength,
} from "@bunvex/server/executor";
import type { WireFile } from "./child-action.ts";
import type { SandboxProcess } from "./host.ts";
import { HostCallBase, thrownToChild } from "./host-call.ts";
import { BadMessageError, type WireResponse } from "./protocol.ts";
import { MARK } from "./streams.ts";
import { decode, encode } from "./wire.ts";

/** How long a child has to acknowledge an action's cut-off before it is killed. */
export const CUT_OFF_GRACE_MS = 1000;

const bad = (what: string): never => {
  throw new BadMessageError(what);
};

/** The operations an action may send, and the methods of each `ctx` object it reaches. */
const ACTION_OPS = new Set([
  "auth.getUserIdentity",
  "runQuery",
  "runMutation",
  "runAction",
  "scheduler",
  "storage",
  "storage.get",
  "storage.store",
  "rooms",
  "presence",
  "vectorSearch",
  "meta",
  "createFunctionHandle",
  "fetch",
]);
/** What an HTTP action may send besides: its request's multipart body to parse (Convex's `form/parseMultiPart`). */
const HTTP_OPS = new Set(["formData"]);
const SCHEDULER_METHODS = ["runAfter", "runAt", "cancel"];
const STORAGE_METHODS = ["getUrl", "getMetadata", "generateUploadUrl", "delete", "store"];
const ROOMS_METHODS = ["broadcast", "members"];
const PRESENCE_METHODS = ["list"];

/** Bytes up to this size go back inline (base64 in the reply); larger ones as a stream. */
const INLINE_BYTES = 64 << 10;

// biome-ignore lint/suspicious/noExplicitAny: an action's `ctx`, driven as the app drove the child's
type Ctx = any;

type Counted = {
  names: string[];
  settled: boolean;
  started: Promise<void>;
  start: () => void;
  /** Set when the call's answer named it still pending: once its engine call settles, it stays counted. */
  kept?: Map<string, number>;
};

/** The operations whose engine call starts only once their bytes are in (a request body, a stored file). */
const LATE = new Set(["fetch", "storage.store"]);

/** An HTTP action's response, and when its call ends (its body handed over). */
export type HttpOutcome = { response: Response | undefined; ended: Promise<void> };

export class HostActionCall extends HostCallBase {
  /** Set for an HTTP action: what its `response` message is handed to. */
  private onResponse: ((m: WireResponse) => void) | null = null;
  /** An HTTP action's response body, opened as its `response` message is read (its chunks may follow at once). */
  private responseStream: ReadableStream<Uint8Array> | null = null;
  private killer: ReturnType<typeof realRuntime.setTimeout> | null = null;
  /**
   * Each operation's pending names (the unawaited-operations warning's, the engine's own `tracked` ones), once its
   * engine call started (`started`), and whether it has settled.
   */
  private readonly counted = new Map<number, Counted>();

  constructor(
    child: SandboxProcess,
    private readonly ctx: Ctx,
  ) {
    super(child);
  }

  /** Runs action `fn` of version `version` to its end, its cut-off or its child's death. */
  async run(fn: string, version: number, args: unknown): Promise<unknown> {
    const all = currentAllEnv();
    this.child.openCall(this.id, this.sink());
    this.child.send({
      t: "action",
      id: this.id,
      version,
      fn,
      args: encode(args),
      env: all ? Object.entries(all) : null,
      meta: this.ctx.meta ? Object.keys(this.ctx.meta) : [],
    });
    return this.loop();
  }

  /**
   * Runs the HTTP action of `route` with `request`: its response once the child answered (undefined when the handler
   * returned something else, which the server refuses as it refuses it in-process), and when its call ends.
   */
  async runHttp(route: [string, string], version: number, request: Request): Promise<HttpOutcome> {
    const all = currentAllEnv();
    let head!: (m: WireResponse | undefined) => void;
    const answered = new Promise<WireResponse | undefined>((resolve) => (head = resolve));
    this.onResponse = (m) => head(m);
    this.child.openCall(this.id, this.sink());
    const body = request.body === null ? null : this.child.streams.send(request.body);
    this.child.send({
      t: "http",
      id: this.id,
      version,
      route,
      request: { url: request.url, method: request.method, headers: [...request.headers], body },
      env: all ? Object.entries(all) : null,
      meta: this.ctx.meta ? Object.keys(this.ctx.meta) : [],
    });
    // The client left: the handler's request signal aborts, as in-process (Bun's `req.signal`).
    const signal = request.signal;
    const disconnect = () => this.child.send({ t: "disconnect", id: this.id, reason: thrownToChild(signal.reason) });
    if (signal.aborted) disconnect();
    else signal.addEventListener("abort", disconnect, { once: true });
    const done = this.loop().finally(() => signal.removeEventListener("abort", disconnect));
    // An answer with no response: its handler returned something else, or threw (the call's error).
    void done.then(
      () => head(undefined),
      () => head(undefined),
    );
    const m = await answered;
    const ended = done.then(
      () => {},
      () => {},
    );
    if (m === undefined) {
      await done;
      return { response: undefined, ended };
    }
    const init = { status: m.status, statusText: m.statusText, headers: m.headers };
    const b = m.body;
    if (b === null) {
      await ended;
      return { response: new Response(null, init), ended };
    }
    if (b.kind === "stream") return { response: new Response(this.responseBody(ended), init), ended };
    // Known length: the server reads it as it reads one made in-process (`bodyLength`: its type and length). Past the
    // cap it is gathered first, so the server drops it as in-process (whole, not a MiB at a time).
    if (b.kind === "whole" && !b.gather)
      return { response: withBodyLength(new Response(this.responseBody(ended), init), b.length), ended };
    let bytes: Uint8Array;
    if (b.kind === "bytes") {
      const v = this.checked(() => decode(b.b, true));
      if (!(v instanceof ArrayBuffer)) {
        this.child.kill("badMessage", "sent a response body that is not bytes");
        throw new ExecutorFailure("the function sandbox's process sent a message that is not valid: response");
      }
      bytes = new Uint8Array(v);
    } else bytes = new Uint8Array(await new Response(this.responseStream!).arrayBuffer());
    await ended;
    return { response: withBodyLength(new Response(bytes, init), b.length), ended };
  }

  /**
   * The response's body from the child: it ends once its call has (its `done` counted what it left pending, for the
   * warnings the server gives at the body's end); a mark is where the child dropped a chunk past the limit (the app's,
   * whole), handed to the server's meter as that chunk.
   */
  private responseBody(ended: Promise<void>): ReadableStream<Uint8Array> {
    const reader = this.responseStream!.getReader();
    let over = false;
    void ended.then(() => {
      over = true;
    });
    const value = (v: unknown) => (v === (MARK as unknown) ? BODY_OVER_LIMIT : v) as Uint8Array;
    return new ReadableStream<Uint8Array>(
      {
        // A body's last chunk and its end come together (the child flushes them with its `done`), so Bun has a body
        // that ends with its chunk at once, and sends its length, as in-process (DV-483).
        async pull(controller) {
          const r = await reader.read();
          if (!r.done) return controller.enqueue(value(r.value));
          if (!over) await ended;
          controller.close();
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
  }

  /**
   * The child's messages for the call. An HTTP action's response body is opened as its head is read, before the frames
   * after it are: the child may send its chunks and its end right after the head.
   */
  protected override sink() {
    const sink = super.sink();
    return {
      ...sink,
      message: (m: Parameters<typeof sink.message>[0]) => {
        if (m.t === "response" && this.onResponse !== null && this.responseStream === null && m.body)
          if (m.body.kind !== "bytes") this.responseStream = this.child.streams.receive(m.body.s);
        sink.message(m);
      },
    };
  }

  /** The call's messages, to its `done`, its cut-off or its child's death. */
  private async loop(): Promise<unknown> {
    const signal = currentActionSignal();
    const cutOff = () => this.push({ t: "cutOff", error: signal!.reason });
    if (signal?.aborted) cutOff();
    else signal?.addEventListener("abort", cutOff, { once: true });
    let cut: unknown = null;
    try {
      for (;;) {
        const item = await this.next();
        switch (item.t) {
          case "gone":
            throw new ExecutorFailure(item.e.message);
          case "timeout":
            continue;
          case "cutOff":
            // The engine already failed the action (`withActionTimeout`): this only stops the child's handler.
            cut = item.error;
            this.child.send({ t: "cancel", id: this.id, error: thrownToChild(item.error) });
            this.killer = realRuntime.setTimeout(() => {
              this.child.kill(
                "timeout",
                `did not stop an action past its time within ${CUT_OFF_GRACE_MS} ms (JavaScript that never yields)`,
              );
            }, CUT_OFF_GRACE_MS);
            continue;
          case "cancelled":
            if (cut === null) {
              this.child.kill("badMessage", "said an action was cut off that was not");
              throw new ExecutorFailure("the function sandbox's process sent a message that is not valid: cancelled");
            }
            throw cut;
          case "lines":
            for (const line of item.lines) this.logLine(line);
            continue;
          case "response":
            if (this.onResponse === null) {
              this.child.kill("badMessage", "sent an HTTP action's response for an action");
              throw new ExecutorFailure("the function sandbox's process sent a message that is not valid: response");
            }
            this.onResponse(item);
            this.onResponse = () => {
              this.child.kill("badMessage", "sent an HTTP action's response twice");
            };
            continue;
          case "op":
            for (const line of item.report.lines) this.logLine(line);
            this.start(item, () => {
              const c = this.counted.get(item.op);
              if (!c) return;
              c.settled = true;
              if (c.kept) for (const name of c.names) c.kept.set(name, (c.kept.get(name) ?? 0) + 1);
            });
            continue;
          case "done":
            for (const line of item.report.lines) this.logLine(line);
            await this.stillPending(item.pending ?? []);
            // An operation the action did not await goes on, pending (the unawaited-operations warning), as under
            // `vm`: the action's answer does not wait for it.
            return this.checked(() => this.result(item));
        }
      }
    } finally {
      if (this.killer !== null) realRuntime.clearTimeout(this.killer);
      signal?.removeEventListener("abort", cutOff);
    }
  }

  protected refused(name: string): string | null {
    if (ACTION_OPS.has(name) || (this.onResponse !== null && HTTP_OPS.has(name))) return null;
    return `sent an operation its function may not run (${name} in an action)`;
  }

  /**
   * The operations the action returned without the answer of: still pending, as they are for Convex (its isolate had
   * not taken their answers) and as under `vm`, though their answers may have left the host already.
   */
  private async stillPending(ops: number[]) {
    const pending = currentPendingOps();
    if (!pending) return;
    // An operation whose bytes are still coming has not started its engine call (where it counts): wait for that, a
    // while at most (the bytes come from the child, which sent its answer after them).
    const starts = ops.map((op) => this.counted.get(op)?.started);
    let timer: ReturnType<typeof realRuntime.setTimeout> | null = null;
    await Promise.race([
      Promise.all(starts),
      new Promise<void>((resolve) => (timer = realRuntime.setTimeout(resolve, CUT_OFF_GRACE_MS))),
    ]);
    if (timer !== null) realRuntime.clearTimeout(timer);
    for (const op of ops) {
      const c = this.counted.get(op);
      if (!c) continue;
      // Still running here: counted by the engine until it settles, and then by the call (an HTTP action's warnings
      // come once its response is sent, which may be after that).
      if (!c.settled) c.kept = pending;
      else for (const name of c.names) pending.set(name, (pending.get(name) ?? 0) + 1);
    }
  }

  dispatch(name: string, args: unknown[], op: number): unknown {
    let start!: () => void;
    const c: Counted = { names: [], settled: false, started: new Promise((r) => (start = r)), start };
    this.counted.set(op, c);
    // Its engine call starts later; one that fails before starts nothing.
    if (LATE.has(name)) return (this.operation(name, args, op) as Promise<unknown>).finally(c.start);
    return this.engineCall(op, () => this.operation(name, args, op));
  }

  /** `call`, the engine's call of operation `op`: the pending names it counts are read as it starts. */
  private engineCall<T>(op: number, call: () => T): T {
    const c = this.counted.get(op)!;
    const pending = currentPendingOps();
    const before = pending ? new Map(pending) : null;
    try {
      return call();
    } finally {
      if (pending && before) for (const [k, n] of pending) for (let i = before.get(k) ?? 0; i < n; i++) c.names.push(k);
      c.start();
    }
  }

  private operation(name: string, args: unknown[], op: number): unknown {
    const ctx = this.ctx;
    switch (name) {
      case "auth.getUserIdentity":
        return ctx.auth.getUserIdentity();
      case "runQuery":
      case "runMutation":
      case "runAction":
        return ctx[name](args[0], args[1]);
      case "scheduler":
        return ctx.scheduler[this.method(args, SCHEDULER_METHODS, "ctx.scheduler")](...args.slice(1));
      case "storage":
        return ctx.storage[this.method(args, STORAGE_METHODS, "ctx.storage")](...args.slice(1));
      case "storage.get":
        return this.storageGet(args[0]);
      case "storage.store":
        return this.storageStore(args[0], args[1], op);
      case "rooms":
        return ctx.rooms[this.method(args, ROOMS_METHODS, "ctx.rooms")](...args.slice(1));
      case "presence":
        return ctx.presence[this.method(args, PRESENCE_METHODS, "ctx.presence")](...args.slice(1));
      case "vectorSearch": {
        const q = args[2];
        if (q === null || typeof q !== "object" || Array.isArray(q)) return bad("a vector search that is not one");
        const { filter, ...rest } = q as Record<string, unknown>;
        // The filter the app built in the child, as its expression: the engine checks it as its own.
        return ctx.vectorSearch(args[0], args[1], "filter" in q ? { ...rest, filter: () => filter } : rest);
      }
      case "meta":
        return ctx.meta[this.method(args, ctx.meta ? Object.keys(ctx.meta) : [], "ctx.meta")]();
      case "createFunctionHandle":
        return createFunctionHandle(args[0]);
      case "fetch":
        return this.fetch(args[0], op);
      case "formData":
        return this.formData(args[0], args[1]);
    }
    return bad(`no operation ${name}`);
  }

  // ------------------------------------------------------------------ storage

  private async storageGet(storageId: unknown): Promise<WireFile | null> {
    const blob = (await this.ctx.storage.get(storageId)) as Blob | null;
    if (blob === null) return null;
    return this.file(blob);
  }

  /** A `Blob` for the child: its type and size, its bytes inline or as a stream. */
  private async file(blob: Blob): Promise<WireFile> {
    if (blob.size <= INLINE_BYTES) return { type: blob.type, size: blob.size, b: await blob.arrayBuffer() };
    return { type: blob.type, size: blob.size, s: this.child.streams.send(blob.stream()) };
  }

  private async storageStore(file: unknown, opts: unknown, op: number): Promise<unknown> {
    const parts = await this.fileBytes(file);
    const f = file as WireFile;
    return this.engineCall(op, () => this.ctx.storage.store(new SpecBlob(parts, { type: f.type }), opts));
  }

  /** A file the child sent: its bytes (as they came, not joined), checked against the size it said. */
  private async fileBytes(file: unknown): Promise<(ArrayBuffer | Uint8Array)[]> {
    if (file === null || typeof file !== "object") return bad("a file that is not one");
    const f = file as Partial<WireFile>;
    if (typeof f.type !== "string" || !Number.isSafeInteger(f.size) || (f.size as number) < 0)
      return bad("a file without its type and size");
    const parts: (ArrayBuffer | Uint8Array)[] = [];
    let n = 0;
    if (f.b instanceof ArrayBuffer && f.s === undefined) {
      parts.push(f.b);
      n = f.b.byteLength;
    } else if (typeof f.s === "number" && f.b === undefined) {
      for await (const c of this.child.streams.receive(f.s)) {
        n += c.byteLength;
        if (n > (f.size as number)) return bad("a file longer than it said");
        parts.push(c);
      }
    } else return bad("a file without its bytes");
    if (n !== f.size) return bad("a file of another size than it said");
    return parts;
  }

  // ------------------------------------------------------------------ HTTP actions

  /**
   * The request's multipart body, parsed here as Convex parses it (`form/parseMultiPart`, an operation: pending as
   * `formData` until it settles, as `trackedFormData` counts it in-process) by the same parser as in-process (Bun's
   * `formData()`); its files go back as files do.
   */
  private formData(contentType: unknown, body: unknown): Promise<unknown> {
    if (typeof contentType !== "string") return bad("a form's type that is not text");
    const b = body as { s?: unknown } | null;
    if (b === null || typeof b !== "object" || typeof b.s !== "number") return bad("a form without its body");
    const stream = this.child.streams.receive(b.s);
    return trackedOperation("formData", async () => {
      const form = await new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": contentType },
        body: stream,
        duplex: "half",
      } as RequestInit).formData();
      const entries: unknown[] = [];
      for (const [name, value] of form as unknown as Iterable<[string, string | File]>) {
        if (typeof value === "string") entries.push([name, value]);
        else entries.push([name, { file: await this.file(value), name: value.name, lastModified: value.lastModified }]);
      }
      return entries;
    });
  }

  // ------------------------------------------------------------------ fetch

  /**
   * The child's `fetch`, made here with the global `fetch` in the action's context: the action's signal, its
   * sender (`isolateFetch` through the deployment's proxy or the address screen) and its egress meter, as under `vm`.
   */
  private async fetch(request: unknown, op: number): Promise<unknown> {
    if (request === null || typeof request !== "object") return bad("a fetch that is not one");
    const r = request as { input?: unknown; request?: unknown; init?: unknown; aborted?: unknown };
    const abort = new AbortController();
    if (r.aborted === true) abort.abort();
    const key = `${this.id}:${op}`;
    this.child.fetches.set(key, abort);
    let input: string | Request;
    if (r.request !== undefined) {
      const q = r.request as Record<string, unknown>;
      if (q === null || typeof q !== "object" || typeof q.url !== "string")
        return bad("a fetch's request that is not one");
      const body = await this.body(q.body);
      input = new Request(q.url, {
        method: q.method as string,
        headers: q.headers as ConstructorParameters<typeof Headers>[0],
        redirect: q.redirect as RequestInit["redirect"],
        ...(body === undefined || body === null ? {} : { body: body as RequestInit["body"], duplex: "half" }),
      } as RequestInit);
    } else if (typeof r.input === "string") input = r.input;
    else return bad("a fetch without its input");
    let init: RequestInit = { signal: abort.signal };
    if (r.init !== undefined) {
      if (r.init === null || typeof r.init !== "object") return bad("a fetch's options that are not an object");
      const { body, signal: _, ...rest } = r.init as Record<string, unknown>;
      init = { ...rest, signal: abort.signal } as RequestInit;
      if ("body" in (r.init as object)) {
        const b = await this.body(body);
        if (b !== undefined) init.body = b as RequestInit["body"];
        else (init as Record<string, unknown>).body = undefined;
      }
    }
    let response: Response;
    try {
      response = await this.engineCall(op, () => fetch(input, init));
    } catch (e) {
      this.child.fetches.delete(key);
      throw e;
    }
    const body = response.body;
    const out = {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
      url: response.url,
      redirected: response.redirected,
      type: response.type,
      body: body === null ? null : this.child.streams.send(this.untilDone(body, key)),
    };
    if (body === null) this.child.fetches.delete(key);
    return out;
  }

  /** `body`, read until it ends: its fetch no longer aborts then. */
  private async *untilDone(body: ReadableStream<Uint8Array>, key: string): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of body) yield chunk;
    } finally {
      this.child.fetches.delete(key);
    }
  }

  /** A request body the child described, as the app passed it (so the host's `fetch` reads it as it would have). */
  private async body(d: unknown): Promise<unknown> {
    if (d === null) return null;
    if (typeof d !== "object") return bad("a body that is not one");
    const b = d as Record<string, unknown>;
    switch (b.kind) {
      case "undefined":
        return undefined;
      case "text":
        return typeof b.text === "string" ? b.text : bad("a text body without its text");
      case "params":
        return typeof b.text === "string" ? new URLSearchParams(b.text) : bad("a form body without its text");
      case "stream":
        return typeof b.s === "number" ? this.child.streams.receive(b.s) : bad("a stream body without its stream");
      case "bytes":
        return new Uint8Array(await new Blob(await this.fileBytes(b.file)).arrayBuffer());
      case "blob": {
        const f = b.file as WireFile;
        return new Blob(await this.fileBytes(f), { type: f.type });
      }
      case "form": {
        if (!Array.isArray(b.entries)) return bad("a form without its entries");
        const form = new FormData();
        for (const e of b.entries) {
          if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string") return bad("a form entry");
          const [name, value] = e as [string, unknown];
          if (typeof value === "string") form.append(name, value);
          else {
            const v = value as { file?: WireFile; name?: unknown; lastModified?: unknown };
            if (typeof v?.name !== "string" || typeof v.lastModified !== "number") return bad("a form's file");
            form.append(
              name,
              new File(await this.fileBytes(v.file), v.name, { type: v.file!.type, lastModified: v.lastModified }),
            );
          }
        }
        return form;
      }
    }
    return bad("a body of no kind");
  }
}

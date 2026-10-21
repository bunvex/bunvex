// Byte streams between host and child (STUDY-171 §12, planned in STUDY-168 §14.1): an action's `fetch` body, each
// way, and a stored file's bytes, each way. Bytes never go through JSON: each chunk is a frame of its own
// (`chunkFrame`), at most `CHUNK_BYTES`, and the messages around them (`end`, `fail`, `credit`, `stop`) are small.
//
// - **Marks.** A sender may put a mark (`MARK`) among its chunks (`mark`, in order): the receiver's reader gets it as a
//   value of its own. An HTTP action's body marks where a chunk past the 100 MiB limit was dropped.
// - **Ids.** Each side numbers the streams it sends; a stream is named by its sender's id, so the two sides' ids
//   never meet (a chunk from the child is always for one of the child's streams).
// - **Credit.** A sender sends no more than its receiver granted: `credit` messages give it bytes, as the receiver's
//   reader takes them. So a stream that nobody reads holds at most a window in memory, and a slow reader slows its
//   sender down. The host's streams start with `WINDOW_BYTES` of credit (the child takes what the host sends as it
//   comes); the child's start with none, until the host opens them (`receive`), so the child can never send the host
//   a byte it did not ask for.
// - **Checks.** On the host (`strict`), a chunk for a stream it did not open, over its credit or over
//   `CHUNK_BYTES`, an `end` or a `fail` for no stream, is the child's fault (`BadMessageError`): the child is killed.
//   A `credit` or a `stop` for a stream that ended is not: the receiver may not have heard yet.

import { BadMessageError, type WireThrown } from "./protocol.ts";

/** A mark among a stream's chunks: a source yields it, the receiver's reader reads it. */
export const MARK: unique symbol = Symbol("mark");

/** The most bytes in one chunk: STUDY-168 §14.1's 1 MiB. */
export const CHUNK_BYTES = 1 << 20;
/** How many bytes a receiver lets its sender send ahead of its reader. */
export const WINDOW_BYTES = 4 << 20;

/** Where a side's stream frames go: its messages and its chunks, in order, on its one socket. */
export type StreamSink = {
  message(m: StreamMessage): void;
  chunk(s: number, bytes: Uint8Array): void;
};

/** The messages about a stream (both ways). */
export type StreamMessage =
  | { t: "end"; s: number }
  | { t: "mark"; s: number }
  | { t: "fail"; s: number; error: WireThrown }
  | { t: "credit"; s: number; n: number }
  | { t: "stop"; s: number };

export type StreamOptions = {
  /** The host's: the other side is the child, and every frame it sends about a stream is checked. */
  strict: boolean;
  /** The credit a stream this side sends starts with. */
  initialCredit: number;
  /** A sent stream's failure, for the wire (a `fetch` body's read error). */
  thrown: (e: unknown) => WireThrown;
  /** A received stream's failure, from the wire. */
  error: (w: WireThrown) => unknown;
};

const bad = (what: string): never => {
  throw new BadMessageError(what);
};

/** A stream this side receives: its chunks queued until its reader takes them, its credit given back as it does. */
class Incoming {
  readonly queue: (Uint8Array | typeof MARK)[] = [];
  /** Granted and not yet received (strict side only: what the sender may still send). */
  open = 0;
  /** Taken by the reader since the last credit sent. */
  owed = 0;
  done: { error: unknown } | { end: true } | null = null;
  wake: (() => void) | null = null;
  claimed = false;
  /** This side stopped it (`stop`): what the sender had in flight still comes, and is dropped. */
  stopped = false;
  readonly stream: ReadableStream<Uint8Array>;

  constructor(
    readonly s: number,
    private readonly streams: Streams,
  ) {
    this.stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          while (!this.queue.length && !this.done) await new Promise<void>((resolve) => (this.wake = resolve));
          const next = this.queue.shift();
          if (next === MARK) {
            controller.enqueue(MARK as unknown as Uint8Array);
            return;
          }
          if (next) {
            controller.enqueue(next);
            this.owed += next.byteLength;
            this.streams.taken(this);
            return;
          }
          const d = this.done!;
          this.streams.forget(this);
          if ("error" in d) controller.error(d.error);
          else controller.close();
        },
        cancel: () => {
          this.streams.stopReceiving(this);
        },
      },
      { highWaterMark: 0 },
    );
  }

  notify() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }
}

/** A stream this side sends: read from its source as its credit allows. */
class Outgoing {
  credit: number;
  stopped = false;
  wake: (() => void) | null = null;
  constructor(
    initial: number,
    /** What the sender does when the receiver stops the stream (`stop`). */
    readonly onStop?: () => void,
    /** What it does once the stream is over for it: its end or failure sent, or it stopped. */
    readonly onEnd?: () => void,
  ) {
    this.credit = initial;
  }
  notify() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }
}

/** One side's byte streams (the host has one per child, the child one for its host). */
export class Streams {
  private readonly incoming = new Map<number, Incoming>();
  private readonly outgoing = new Map<number, Outgoing>();
  private next = 0;
  private gone: unknown = null;

  constructor(
    private readonly sink: StreamSink,
    private readonly opts: StreamOptions,
  ) {}

  /**
   * Sends `source`'s bytes as a new stream, as its credit allows; its id, for the other side to `receive`. `onStop`:
   * told at once when the receiver stops it (the source may be waiting for bytes that never come); `onEnd`: once the
   * stream is over for this side (its end or failure sent, or stopped).
   */
  send(
    source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | ArrayBufferView | string | typeof MARK>,
    onStop?: () => void,
    onEnd?: () => void,
  ): number {
    const s = ++this.next;
    const out = new Outgoing(this.opts.initialCredit, onStop, onEnd);
    this.outgoing.set(s, out);
    void this.pump(s, out, source);
    return s;
  }

  /** Sends `bytes` as a new stream. */
  sendBytes(bytes: Uint8Array): number {
    return this.send(
      (async function* () {
        for (let i = 0; i < bytes.byteLength; i += CHUNK_BYTES) yield bytes.subarray(i, i + CHUNK_BYTES);
      })(),
    );
  }

  private async pump(
    s: number,
    out: Outgoing,
    source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | ArrayBufferView | string | typeof MARK>,
  ) {
    const it = (
      source instanceof ReadableStream ? source[Symbol.asyncIterator]() : source[Symbol.asyncIterator]()
    ) as AsyncIterator<Uint8Array | ArrayBufferView | string | typeof MARK>;
    try {
      for (;;) {
        if (out.stopped || this.gone) break;
        const r = await it.next();
        if (r.done) break;
        if (r.value === MARK) {
          if (!out.stopped && !this.gone) this.sink.message({ t: "mark", s });
          continue;
        }
        let bytes = asBytes(r.value);
        while (bytes.byteLength) {
          while (out.credit <= 0 && !out.stopped && !this.gone) await new Promise<void>((w) => (out.wake = w));
          if (out.stopped || this.gone) break;
          const n = Math.min(bytes.byteLength, out.credit, CHUNK_BYTES);
          this.sink.chunk(s, bytes.subarray(0, n));
          out.credit -= n;
          bytes = bytes.subarray(n);
        }
      }
      if (!out.stopped && !this.gone) this.sink.message({ t: "end", s });
    } catch (e) {
      if (!out.stopped && !this.gone) this.sink.message({ t: "fail", s, error: this.opts.thrown(e) });
    } finally {
      this.outgoing.delete(s);
      if (out.stopped || this.gone) await Promise.resolve(it.return?.()).catch(() => {});
      out.onEnd?.();
    }
  }

  /**
   * The stream the other side sends as `s`. On the host, it is opened here (and given its first credit): a second
   * `receive` of the same id, or of one that already sent, is a bad message.
   */
  receive(s: number): ReadableStream<Uint8Array> {
    let inc = this.incoming.get(s);
    if (this.opts.strict) {
      if (inc || !Number.isSafeInteger(s) || s <= 0) bad(`a stream opened twice or not one (${s})`);
      inc = new Incoming(s, this);
      inc.claimed = true;
      this.incoming.set(s, inc);
      if (this.gone) inc.done = { error: this.gone };
      else {
        inc.open = WINDOW_BYTES;
        this.sink.message({ t: "credit", s, n: WINDOW_BYTES });
      }
      return inc.stream;
    }
    if (!inc) {
      inc = new Incoming(s, this);
      this.incoming.set(s, inc);
      if (this.gone) inc.done = { error: this.gone };
    }
    if (inc.claimed) bad(`the stream ${s} received twice`);
    inc.claimed = true;
    return inc.stream;
  }

  /** The other side's chunk of stream `s`. */
  onChunk(s: number, bytes: Uint8Array) {
    let inc = this.incoming.get(s);
    if (this.opts.strict) {
      // In flight when this side said `stop`: dropped, within the credit it had given.
      if (inc?.stopped) {
        if (bytes.byteLength > inc.open) return bad(`a chunk past its stream's credit (${s})`);
        inc.open -= bytes.byteLength;
        return;
      }
      if (!inc || inc.done) return bad(`a chunk for no open stream (${s})`);
      if (bytes.byteLength > CHUNK_BYTES) return bad(`a chunk of ${bytes.byteLength} bytes, over ${CHUNK_BYTES}`);
      if (bytes.byteLength > inc.open) return bad(`a chunk past its stream's credit (${s})`);
      inc.open -= bytes.byteLength;
    } else if (!inc) {
      // The host's chunks may come before the message that names their stream is read.
      inc = new Incoming(s, this);
      this.incoming.set(s, inc);
    }
    if (inc.done) return;
    inc.queue.push(bytes);
    inc.notify();
  }

  onMessage(m: StreamMessage) {
    switch (m.t) {
      case "credit": {
        const out = this.outgoing.get(m.s);
        if (!out) return;
        out.credit += m.n;
        out.notify();
        return;
      }
      case "stop": {
        const out = this.outgoing.get(m.s);
        if (!out) return;
        out.stopped = true;
        out.notify();
        out.onStop?.();
        return;
      }
      case "mark": {
        const inc = this.incoming.get(m.s);
        if (!inc || inc.done)
          return this.opts.strict && !inc?.stopped ? bad(`a mark for no open stream (${m.s})`) : undefined;
        if (inc.stopped) return;
        inc.queue.push(MARK);
        inc.notify();
        return;
      }
      case "end":
      case "fail": {
        let inc = this.incoming.get(m.s);
        if (!inc) {
          if (this.opts.strict) return bad(`an ${m.t} for no open stream (${m.s})`);
          inc = new Incoming(m.s, this);
          this.incoming.set(m.s, inc);
        }
        if (inc.stopped) return;
        if (inc.done) return this.opts.strict ? bad(`an ${m.t} for a stream that ended (${m.s})`) : undefined;
        inc.done = m.t === "end" ? { end: true } : { error: this.opts.error(m.error) };
        inc.notify();
        return;
      }
    }
  }

  /** The reader took bytes: they are the sender's again, given back by the half window. */
  taken(inc: Incoming) {
    if (inc.done || this.gone) return;
    if (inc.owed >= WINDOW_BYTES / 2 || inc.queue.length === 0) {
      const n = inc.owed;
      inc.owed = 0;
      if (this.opts.strict) inc.open += n;
      if (n > 0) this.sink.message({ t: "credit", s: inc.s, n });
    }
  }

  /** Fails stream `s` this side sends with `error` now: what its source still makes is not sent. */
  failOutgoing(s: number, error: WireThrown) {
    const out = this.outgoing.get(s);
    if (!out || out.stopped) return;
    out.stopped = true;
    out.notify();
    if (!this.gone) this.sink.message({ t: "fail", s, error });
  }

  /** Stops stream `s` the other side sends, if it is still coming (nobody will read it); one read to its end is gone. */
  stopIncoming(s: number) {
    const inc = this.incoming.get(s);
    if (inc) this.stopReceiving(inc);
  }

  /** The reader is done with an ended stream. */
  forget(inc: Incoming) {
    if (this.incoming.get(inc.s) === inc && inc.queue.length === 0) {
      // Kept on the strict side, so a chunk after `end` is still refused.
      if (!this.opts.strict) this.incoming.delete(inc.s);
    }
  }

  /** The reader cancelled: the sender stops, and what it still sends is dropped. */
  stopReceiving(inc: Incoming) {
    if (!inc.done) {
      inc.done = { end: true };
      inc.stopped = true;
      if (!this.gone) this.sink.message({ t: "stop", s: inc.s });
    }
    inc.queue.length = 0;
    if (!this.opts.strict) this.incoming.delete(inc.s);
  }

  /** The other side is gone: every stream fails with `error`, and nothing more is sent. */
  failAll(error: unknown) {
    if (this.gone) return;
    this.gone = error;
    for (const inc of this.incoming.values())
      if (!inc.done) {
        inc.done = { error };
        inc.notify();
      }
    for (const out of this.outgoing.values()) out.notify();
  }

  /** How many streams are open each way (tests). */
  get sizes() {
    return { incoming: [...this.incoming.values()].filter((i) => !i.done).length, outgoing: this.outgoing.size };
  }
}

const encoder = new TextEncoder();

/** A chunk as bytes: a string as UTF-8, any view as its bytes. */
function asBytes(x: Uint8Array | ArrayBufferView | string | ArrayBuffer): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (typeof x === "string") return encoder.encode(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  throw new TypeError("a stream's chunk must be bytes");
}

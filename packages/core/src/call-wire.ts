// The function call boundary's messages (STUDY-194 §4.4, §4.5; STUDY-190 PR 2a): what the main thread hands the body
// runner for one query or mutation, and what comes back. Convex's seam is the same one call
// (`FunctionRunner::run_function`, crates/function_runner/src/lib.rs): a request at a timestamp, and back the outcome
// with the read set and the writes, which the backend commits.
//
// Every message is one string, in #878's format (`persistence/sqlite-writer.ts`): fields one after the other, a string
// as its length, `:` and its characters, a number as its digits and `:`, null as `_`, keys one character per byte
// (STUDY-194 §4.2: structured clone costs 1.5–2× this). A message begins with its kind and its call id, `c<id>:` for
// a request and `o<id>:` for an outcome. A message that does not parse is refused with where it went wrong.
import type { Interval, LoggedIndexWrite, SearchRead } from "./committer.ts";
import type { DocWrite } from "./persistence/index.ts";
import { WireWriter } from "./persistence/sqlite-writer.ts";
import type { SessionRequestId } from "./session-requests.ts";

export type CallKind = "query" | "mutation";

/** What a call names: the function, its arguments, and what the dispatcher already established about the caller. */
export type CallSpec = {
  kind: CallKind;
  /** The path as the caller gave it, or a component function's registry name. */
  name: string;
  /** The arguments, as value JSON text (`stringifyValue`). */
  args: string;
  /** Whether the caller may reach an internal function (Convex's `AllowedVisibility`): checked on the main thread. */
  internal: boolean;
  /** A sync session's mutation (STUDY-23 §4.3): run at most once per request, recorded in the same transaction. */
  session: SessionRequestId | null;
};

/** The request (STUDY-194 §4.4): the call, and the transaction the main thread chose for it. */
export type CallRequest = CallSpec & {
  id: number;
  /** The snapshot: the main thread's visible timestamp, or the one asked for. */
  ts: bigint;
  /** The transaction's start: its first `_creationTime`, and `Date.now()`'s floor. */
  now: number;
  /** The caller's identity as JSON text (opaque to the engine), or null. */
  identity: string | null;
  /** An admin or the system acting as itself (`Caller.systemIdentity`). */
  systemIdentity: boolean;
  /** The request the call comes from (`ctx.meta.getRequestMetadata()`), as JSON text, or null. */
  request: string | null;
  /** A subscription's run (`Engine.queryTracked`): reactive pagination's journal, and no index cache. */
  tracked: boolean;
  /** That subscription's end cursor from its previous run (Convex's `QueryJournal`). */
  journal: string | null;
  /**
   * The mutation's permit was refused (Convex's d328f85): a session's recorded outcome is still answered, otherwise
   * the call ends `refused` without running and the main thread fails it with the permit's error.
   */
  refused: boolean;
};

/** How a call ended: returned, threw, refused (`CallRequest.refused`), or answered from a session's record. */
export type CallStatus = "ok" | "failed" | "refused" | "replayed";

/** A mutation's writes (STUDY-194 §4.5): the documents, their index entries (Q1: computed by the runner), the catalog touches. */
export type CallWrites = {
  docs: DocWrite[];
  idx: LoggedIndexWrite[];
  /** The `_tables`/`_index` keys a schema-changing write touched (`Tx.catalogTouches`), for the write log. */
  touches: { index: string; key: Uint8Array; id: null }[];
};

/** The outcome (STUDY-194 §4.5): what the main thread's engine needs from a run. */
export type CallOutcome = {
  id: number;
  status: CallStatus;
  /**
   * `ok`, a query: its result as value JSON text (null when it is not a value the text can hold; the caller then has
   * none). `replayed`: the session's recorded outcome as JSON text.
   */
  result: string | null;
  /** The read set, also of a failed run: a subscription reruns it when these change. */
  reads: Interval[];
  searchReads: SearchRead[];
  identityObserved: boolean;
  observedTime: boolean;
  /** The end cursor this run's page ended at (a subscription's next journal). */
  endCursor: string | null;
  documentsRead: number;
  bytesRead: number;
  /** A mutation that returned, if it wrote. */
  writes: CallWrites | null;
};

/** A message that does not parse: which message, and where in it. */
export class MalformedCallMessageError extends Error {
  override name = "MalformedCallMessageError";
  constructor(
    readonly which: "request" | "outcome",
    readonly path: string,
    problem: string,
  ) {
    super(`A malformed call ${which}: ${path}: ${problem}`);
  }
}

const KIND = { query: "q", mutation: "m" } as const;
const STATUS = { ok: "k", failed: "f", refused: "r", replayed: "p" } as const;
const flag = (b: boolean) => (b ? 1 : 0);

export function encodeCallRequest(r: CallRequest): string {
  const w = new WireWriter();
  w.str(KIND[r.kind]);
  w.str(r.name);
  w.str(r.args);
  w.num(flag(r.internal));
  w.opt(r.session?.sessionId ?? null);
  if (r.session) w.num(r.session.requestId);
  w.num(r.ts);
  w.num(r.now);
  w.opt(r.identity);
  w.num(flag(r.systemIdentity));
  w.opt(r.request);
  w.num(flag(r.tracked));
  w.opt(r.journal);
  w.num(flag(r.refused));
  return `c${r.id}:${w.take()}`;
}

export function decodeCallRequest(s: string): CallRequest {
  const r = new WireReader(s, "request");
  const id = r.open("c");
  r.at("kind");
  const k = r.str();
  const kind = k === "q" ? "query" : k === "m" ? "mutation" : r.fail(`unknown kind ${JSON.stringify(k)}`);
  r.at("name");
  const name = r.str();
  r.at("args");
  const args = r.str();
  r.at("internal");
  const internal = r.bool();
  r.at("session");
  const sessionId = r.opt();
  let session: SessionRequestId | null = null;
  if (sessionId !== null) {
    r.at("session.requestId");
    session = { sessionId, requestId: r.int() };
  }
  r.at("ts");
  const ts = r.big();
  r.at("now");
  const now = r.float();
  r.at("identity");
  const identity = r.opt();
  r.at("systemIdentity");
  const systemIdentity = r.bool();
  r.at("request");
  const request = r.opt();
  r.at("tracked");
  const tracked = r.bool();
  r.at("journal");
  const journal = r.opt();
  r.at("refused");
  const refused = r.bool();
  r.close();
  return {
    id,
    kind,
    name,
    args,
    internal,
    session,
    ts,
    now,
    identity,
    systemIdentity,
    request,
    tracked,
    journal,
    refused,
  };
}

export function encodeCallOutcome(o: CallOutcome): string {
  const w = new WireWriter();
  w.str(STATUS[o.status]);
  w.opt(o.result);
  w.num(flag(o.identityObserved));
  w.num(flag(o.observedTime));
  w.opt(o.endCursor);
  w.num(o.documentsRead);
  w.num(o.bytesRead);
  w.num(o.reads.length);
  for (const i of o.reads) {
    w.str(i.index);
    w.bytes(i.lo);
    w.bytes(i.hi);
  }
  w.num(o.searchReads.length);
  for (const s of o.searchReads) {
    w.str(s.index);
    w.num(s.terms.length);
    for (const t of s.terms) {
      w.str(t.term);
      w.num(flag(t.prefix));
    }
    w.num(s.filters.length);
    for (const [field, key] of s.filters) {
      w.str(field);
      w.str(key);
    }
  }
  const writes = o.writes;
  w.num(flag(writes !== null));
  if (writes) {
    w.num(writes.docs.length);
    for (const d of writes.docs) {
      w.str(d.table);
      w.str(d.id);
      w.opt(d.json);
      w.optNum(d.prevTs);
    }
    w.num(writes.idx.length);
    for (const e of writes.idx) {
      w.str(e.index);
      w.bytes(e.key);
      w.opt(e.table);
      w.opt(e.id);
      w.opt(e.docId ?? null);
    }
    w.num(writes.touches.length);
    for (const t of writes.touches) {
      w.str(t.index);
      w.bytes(t.key);
    }
  }
  return `o${o.id}:${w.take()}`;
}

export function decodeCallOutcome(s: string): CallOutcome {
  const r = new WireReader(s, "outcome");
  const id = r.open("o");
  r.at("status");
  const c = r.str();
  const status: CallStatus =
    c === "k"
      ? "ok"
      : c === "f"
        ? "failed"
        : c === "r"
          ? "refused"
          : c === "p"
            ? "replayed"
            : r.fail(`unknown status ${JSON.stringify(c)}`);
  r.at("result");
  const result = r.opt();
  r.at("identityObserved");
  const identityObserved = r.bool();
  r.at("observedTime");
  const observedTime = r.bool();
  r.at("endCursor");
  const endCursor = r.opt();
  r.at("documentsRead");
  const documentsRead = r.int();
  r.at("bytesRead");
  const bytesRead = r.int();
  r.at("reads");
  const reads: Interval[] = new Array(r.count());
  for (let i = 0; i < reads.length; i++) {
    r.item("reads", i, "index");
    const index = r.str();
    r.item("reads", i, "lo");
    const lo = r.bytes();
    r.item("reads", i, "hi");
    reads[i] = { index, lo, hi: r.bytes() };
  }
  r.at("searchReads");
  const searchReads: SearchRead[] = new Array(r.count());
  for (let i = 0; i < searchReads.length; i++) {
    r.item("searchReads", i, "index");
    const index = r.str();
    r.item("searchReads", i, "terms");
    const terms = new Array<SearchRead["terms"][number]>(r.count());
    for (let j = 0; j < terms.length; j++) {
      r.item("searchReads", i, `terms[${j}]`);
      terms[j] = { term: r.str(), prefix: r.bool() };
    }
    r.item("searchReads", i, "filters");
    const filters = new Array<[string, string]>(r.count());
    for (let j = 0; j < filters.length; j++) {
      r.item("searchReads", i, `filters[${j}]`);
      filters[j] = [r.str(), r.str()];
    }
    searchReads[i] = { index, terms, filters };
  }
  r.at("writes");
  let writes: CallWrites | null = null;
  if (r.bool()) {
    r.at("writes.docs");
    const docs: DocWrite[] = new Array(r.count());
    for (let i = 0; i < docs.length; i++) {
      r.item("writes.docs", i, "");
      docs[i] = { table: r.str(), id: r.str(), json: r.opt(), prevTs: r.optBig() };
    }
    r.at("writes.idx");
    const idx: LoggedIndexWrite[] = new Array(r.count());
    for (let i = 0; i < idx.length; i++) {
      r.item("writes.idx", i, "");
      idx[i] = { index: r.str(), key: r.bytes(), table: r.opt(), id: r.opt(), docId: r.opt() };
    }
    r.at("writes.touches");
    const touches: CallWrites["touches"] = new Array(r.count());
    for (let i = 0; i < touches.length; i++) {
      r.item("writes.touches", i, "");
      touches[i] = { index: r.str(), key: r.bytes(), id: null };
    }
    writes = { docs, idx, touches };
  }
  r.close();
  return {
    id,
    status,
    result,
    reads,
    searchReads,
    identityObserved,
    observedTime,
    endCursor,
    documentsRead,
    bytesRead,
    writes,
  };
}

/** Reads a message field by field, refusing anything `WireWriter` would not have written. */
class WireReader {
  private pos = 0;
  // Where it is, built into a path only when a field is refused.
  private base = "";
  private index = -1;
  private sub = "";

  constructor(
    private readonly s: string,
    private readonly what: "request" | "outcome",
  ) {}

  at(field: string) {
    this.base = field;
    this.index = -1;
  }
  item(list: string, index: number, sub: string) {
    this.base = list;
    this.index = index;
    this.sub = sub;
  }
  fail(problem: string): never {
    const path =
      this.index < 0 ? this.base || "header" : `${this.base}[${this.index}]${this.sub ? `.${this.sub}` : ""}`;
    throw new MalformedCallMessageError(this.what, path, problem);
  }

  /** The message's kind character and its id. */
  open(kind: string): number {
    this.at("header");
    if (this.s[0] !== kind) this.fail(`expected ${JSON.stringify(kind)}, got ${JSON.stringify(this.s.slice(0, 1))}`);
    this.pos = 1;
    return this.int();
  }
  close() {
    this.at("end");
    if (this.pos !== this.s.length) this.fail(`${this.s.length - this.pos} characters past the last field`);
  }

  /** The digits before the next `:`. */
  private digits(): string {
    const start = this.pos;
    let i = start;
    for (; i < this.s.length; i++) {
      const c = this.s.charCodeAt(i);
      if (c === 58 /* : */) break;
      if (c < 48 || c > 57) this.fail(`expected a number, got ${JSON.stringify(this.s.slice(start, i + 1))}`);
    }
    if (i >= this.s.length) this.fail("the message ends inside a field");
    if (i === start) this.fail("an empty number");
    this.pos = i + 1;
    return this.s.slice(start, i);
  }
  private isNull(): boolean {
    if (this.s.charCodeAt(this.pos) !== 95 /* _ */) return false;
    this.pos++;
    return true;
  }
  int(): number {
    const n = Number(this.digits());
    if (!Number.isSafeInteger(n)) this.fail("a number past 2^53");
    return n;
  }
  /** A list's length: no more items than characters left, so a corrupt one cannot allocate. */
  count(): number {
    const n = this.int();
    if (n > this.s.length - this.pos) this.fail(`${n} items, with ${this.s.length - this.pos} characters left`);
    return n;
  }
  bool(): boolean {
    const d = this.digits();
    if (d !== "0" && d !== "1") this.fail(`expected 0 or 1, got ${d}`);
    return d === "1";
  }
  big(): bigint {
    return BigInt(this.digits());
  }
  optBig(): bigint | null {
    return this.isNull() ? null : this.big();
  }
  /** A finite number in JavaScript's own text (a timestamp in ms, with its fraction). */
  float(): number {
    const end = this.s.indexOf(":", this.pos);
    if (end < 0) this.fail("the message ends inside a field");
    const text = this.s.slice(this.pos, end);
    const n = Number(text);
    if (text === "" || !Number.isFinite(n) || String(n) !== text)
      this.fail(`expected a number, got ${JSON.stringify(text)}`);
    this.pos = end + 1;
    return n;
  }
  str(): string {
    const n = this.int();
    if (this.pos + n > this.s.length) this.fail(`a string of ${n} characters, with ${this.s.length - this.pos} left`);
    const v = this.s.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  opt(): string | null {
    return this.isNull() ? null : this.str();
  }
  /** Bytes sent one character per byte. */
  bytes(): Uint8Array {
    const t = this.str();
    const b = new Uint8Array(t.length);
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c > 255) this.fail("a byte past 255");
      b[i] = c;
    }
    return b;
  }
}

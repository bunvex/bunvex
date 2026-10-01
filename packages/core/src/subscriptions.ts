// Reactivity. One Sub per distinct key (the server uses function + args): every client subscribed to the
// same query shares ONE execution, and the result is handed to `publish`, which the transport (the
// server's WebSocket pub/sub) fans out. The core knows no socket.
//
// Invariant: a Sub never misses a commit. Each durable commit is matched against the live Subs' read-sets
// through an index of them (STUDY-08 D9), so only the Subs it overlaps are touched; a Sub that is RUNNING
// when a commit arrives (its read-set is unknown or about to be replaced) is marked dirty and re-runs once
// it finishes.
import type { LogEntry } from "./committer.ts";
import { type Engine, type QueryJournal, stringifyValue, type TxBody } from "./engine.ts";
import { ReadSetIndex } from "./read-set-index.ts";

type Sub = {
  key: string;
  body: TxBody<unknown>;
  /** Creation order: overlapping Subs re-run in this order, as they did when every Sub was scanned. */
  seq: number;
  /** The last published result, and its identity (`v` + JSON of the value, or `e` + the error). */
  last: { msg: SubResult; id: string } | null;
  running: boolean;
  /** Carried across re-runs so a paginated query keeps its page boundary. */
  journal: QueryJournal;
  dirty: boolean;
  refs: number;
};

/**
 * A subscription's result: JSON of the value, or an error — its message, and JSON of the app's error data
 * when there is some (a `BunvexError`'s `data`).
 */
export type SubResult = { value: string } | { error: string; data?: string };
/** The transport's side: send a result to every subscriber of `key`. */
export type Publish = (key: string, msg: SubResult) => void;
/** How a failed run is reported to subscribers. The default is the error's message. */
export type FormatError = (error: unknown) => { error: string; data?: string };
const defaultFormatError: FormatError = (e) => ({ error: String((e as Error)?.message ?? e) });

export class Subscriptions {
  private subs = new Map<string, Sub>();
  /** The read-set of every live Sub that has run once. */
  readonly reads = new ReadSetIndex<Sub>();
  private running = new Set<Sub>();
  private nextSeq = 0;
  stats = { reruns: 0, published: 0 };

  constructor(
    private engine: Engine,
    private publish: Publish,
    private formatError: FormatError = defaultFormatError,
  ) {
    engine.committer.onCommit((entries) => this.onCommit(entries));
  }

  private onCommit(entries: LogEntry[]) {
    // Only live Subs: one still finishing after its key was unsubscribed (and maybe subscribed again) is not.
    for (const s of this.running) if (this.subs.get(s.key) === s) s.dirty = true;
    if (this.reads.size === 0) return;
    const hit = [...this.reads.matchingEntries(entries)].filter((s) => !s.running);
    if (hit.length > 1) hit.sort((a, b) => a.seq - b.seq);
    for (const s of hit) void this.run(s);
  }

  private async run(s: Sub) {
    if (s.running) {
      s.dirty = true;
      return;
    }
    s.running = true;
    this.running.add(s);
    do {
      s.dirty = false;
      this.stats.reruns++;
      const r = await this.engine.queryTracked(s.body, s.journal);
      s.journal = r.journal;
      // A failed run keeps its reads too, so the next overlapping commit re-runs it (Convex re-evaluates
      // errors like any result). Errors and values share `last`, so a value that comes back after an
      // error is published again.
      if (this.subs.get(s.key) === s) this.reads.set(s, r.reads);
      const msg: SubResult = r.ok ? { value: stringifyValue(r.value) } : this.formatError(r.error);
      const id = "value" in msg ? `v${msg.value}` : `e${msg.data ?? ""}\u0000${msg.error}`;
      if (id !== s.last?.id) {
        s.last = { msg, id };
        this.stats.published++;
        this.publish(s.key, msg);
      }
    } while (s.dirty && this.subs.has(s.key));
    s.running = false;
    this.running.delete(s);
  }

  /**
   * Subscribe to `key`, whose result is computed by `body`. Returns the current result when the Sub
   * already has one (the caller sends it to the new subscriber); otherwise null, and the first run
   * publishes to everyone subscribed to the key — the caller must join the key's topic BEFORE calling.
   */
  async subscribe(key: string, body: TxBody<unknown>): Promise<SubResult | null> {
    const s = this.subs.get(key);
    if (s) {
      s.refs++;
      return this.current(key);
    }
    const created: Sub = {
      key,
      body,
      seq: this.nextSeq++,
      last: null,
      running: false,
      dirty: false,
      refs: 1,
      journal: {},
    };
    this.subs.set(key, created);
    await this.run(created);
    return null;
  }

  /** The last published result of `key`, if it has one. */
  current(key: string): SubResult | null {
    return this.subs.get(key)?.last?.msg ?? null;
  }

  unsubscribe(key: string) {
    const s = this.subs.get(key);
    if (s && --s.refs <= 0) {
      this.subs.delete(key);
      this.reads.delete(s);
    }
  }

  get size() {
    return this.subs.size;
  }
}

// Reactivity. One Sub per distinct key (the server uses function + args): every client subscribed to the
// same query shares ONE execution, and the result is handed to `publish`, which the transport (the
// server's WebSocket pub/sub) fans out. The core knows no socket.
//
// Invariant: a Sub never misses a commit. Each durable commit is tested against every live Sub's read-set;
// a Sub that is RUNNING when a commit arrives (its read-set is unknown or about to be replaced) is marked
// dirty and re-runs once it finishes.
import { type Interval, type LogEntry, overlaps } from "./committer.ts";
import { type Engine, type QueryJournal, stringifyValue, type TxBody } from "./engine.ts";

type Sub = {
  key: string;
  body: TxBody<unknown>;
  reads: Interval[] | null;
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
  stats = { reruns: 0, published: 0 };

  constructor(
    private engine: Engine,
    private publish: Publish,
    private formatError: FormatError = defaultFormatError,
  ) {
    engine.committer.onCommit((entries) => this.onCommit(entries));
  }

  private onCommit(entries: LogEntry[]) {
    for (const s of this.subs.values()) {
      if (s.running) {
        s.dirty = true;
        continue;
      }
      if (!s.reads) continue;
      for (const e of entries)
        if (overlaps(e.writes, s.reads)) {
          void this.run(s);
          break;
        }
    }
  }

  private async run(s: Sub) {
    if (s.running) {
      s.dirty = true;
      return;
    }
    s.running = true;
    do {
      s.dirty = false;
      this.stats.reruns++;
      const r = await this.engine.queryTracked(s.body, s.journal);
      s.journal = r.journal;
      // A failed run keeps its reads too, so the next overlapping commit re-runs it (Convex re-evaluates
      // errors like any result). Errors and values share `last`, so a value that comes back after an
      // error is published again.
      s.reads = r.reads;
      const msg: SubResult = r.ok ? { value: stringifyValue(r.value) } : this.formatError(r.error);
      const id = "value" in msg ? `v${msg.value}` : `e${msg.data ?? ""}\u0000${msg.error}`;
      if (id !== s.last?.id) {
        s.last = { msg, id };
        this.stats.published++;
        this.publish(s.key, msg);
      }
    } while (s.dirty && this.subs.has(s.key));
    s.running = false;
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
    const created: Sub = { key, body, reads: null, last: null, running: false, dirty: false, refs: 1, journal: {} };
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
    if (s && --s.refs <= 0) this.subs.delete(key);
  }

  get size() {
    return this.subs.size;
  }
}

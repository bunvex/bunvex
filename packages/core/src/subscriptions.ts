// Reactivity. One Sub per distinct key (the server uses function + args): every client subscribed to the
// same query shares ONE execution, and the result is handed to `publish`, which the transport (the
// server's WebSocket pub/sub) fans out. The core knows no socket.
//
// Invariant: a Sub never misses a commit. Each durable commit is tested against every live Sub's read-set;
// a Sub that is RUNNING when a commit arrives (its read-set is unknown or about to be replaced) is marked
// dirty and re-runs once it finishes.
import { type Interval, type LogEntry, overlaps } from "./committer.ts";
import type { Engine, TxBody } from "./engine.ts";

type Sub = {
  key: string;
  body: TxBody<unknown>;
  reads: Interval[] | null;
  value: string | null; // the last published payload (JSON of the value)
  running: boolean;
  dirty: boolean;
  refs: number;
};

/** The transport's side: send `payload` (JSON of the value) — or an error — to every subscriber of `key`. */
export type Publish = (key: string, msg: { value: string } | { error: string }) => void;

export class Subscriptions {
  private subs = new Map<string, Sub>();
  stats = { reruns: 0, published: 0 };

  constructor(
    private engine: Engine,
    private publish: Publish,
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
      try {
        const r = await this.engine.queryTracked(s.body);
        s.reads = r.reads;
        const payload = JSON.stringify(r.value ?? null);
        if (payload !== s.value) {
          s.value = payload;
          this.stats.published++;
          this.publish(s.key, { value: payload });
        }
      } catch (e) {
        this.publish(s.key, { error: String((e as Error).message ?? e) });
      }
    } while (s.dirty && this.subs.has(s.key));
    s.running = false;
  }

  /**
   * Subscribe to `key`, whose result is computed by `body`. Returns the current payload when the Sub
   * already has one (the caller sends it to the new subscriber); otherwise null, and the first run
   * publishes to everyone subscribed to the key — the caller must join the key's topic BEFORE calling.
   */
  async subscribe(key: string, body: TxBody<unknown>): Promise<string | null> {
    const s = this.subs.get(key);
    if (s) {
      s.refs++;
      return s.value;
    }
    const created: Sub = { key, body, reads: null, value: null, running: false, dirty: false, refs: 1 };
    this.subs.set(key, created);
    await this.run(created);
    return null;
  }

  unsubscribe(key: string) {
    const s = this.subs.get(key);
    if (s && --s.refs <= 0) this.subs.delete(key);
  }

  get size() {
    return this.subs.size;
  }
}

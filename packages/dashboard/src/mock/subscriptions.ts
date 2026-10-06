// The mock's live queries and query cache (STUDY-131 AD-25): a few sessions subscribed to the fixture's
// functions, each query with a read set over the fixture's indexes, and a history ring of what made it run
// again. `step` lands an invalidation (a mutation writing into one query's range), as a commit would; the
// follow stream delivers those.
import type {
  InspectorFilter,
  InvalidationEvent,
  LiveQuery,
  LiveSession,
  QueryCacheEntry,
  QueryCacheSnapshot,
  QueryHistoryEntry,
  ReadBound,
  ReadRange,
  SubscriptionsSnapshot,
} from "../data-source.ts";
import type { Random } from "./random.ts";

const HISTORY = 8;

type Template = {
  path: string;
  /** What it reads: `table.index`, the index fields, the eq prefix (empty: the whole index). */
  index: string;
  fields: string[];
  prefix: string[];
  /** The mutation that writes into it. */
  writer: string;
};

const TEMPLATES: Template[] = [
  {
    path: "tasks:list",
    index: "tasks.by_creation_time",
    fields: ["_creationTime", "_id"],
    prefix: [],
    writer: "tasks:add",
  },
  {
    path: "tasks:byOwner",
    index: "tasks.by_owner",
    fields: ["owner", "_creationTime", "_id"],
    prefix: ["ada"],
    writer: "tasks:setDone",
  },
  {
    path: "messages:list",
    index: "messages.by_channel",
    fields: ["channel", "_creationTime", "_id"],
    prefix: ["general"],
    writer: "messages:send",
  },
  {
    path: "users:me",
    index: "users.by_token",
    fields: ["tokenIdentifier", "_creationTime", "_id"],
    prefix: ["https://auth|ada"],
    writer: "users:store",
  },
];

const text = (v: string) => JSON.stringify(v);
function range(t: Template): ReadRange {
  const lo: ReadBound = t.prefix.length
    ? { kind: "key", values: t.prefix, after: false, text: `[${t.prefix.map(text).join(", ")}]` }
    : { kind: "min", text: "-∞" };
  const hi: ReadBound = t.prefix.length
    ? { kind: "key", values: t.prefix, after: true, text: `[${[...t.prefix.map(text), "…"].join(", ")}]` }
    : { kind: "max", text: "+∞" };
  return { index: t.index, fields: t.fields, lo, hi, text: `[${lo.text}, ${hi.text})` };
}

type Q = {
  session: number;
  queryId: number;
  t: Template;
  digest: string;
  cached: boolean;
  history: QueryHistoryEntry[];
  at: number;
  docs: number;
};

export class MockSubscriptions {
  private queries: Q[] = [];
  private seq = 0;
  ts: number;
  private evictions = 3;
  private hits = 1840;
  private misses = { new: 120, evicted: 3, invalidated: 410, expired: 6, snapshot: 1 };

  constructor(
    private readonly rnd: Random,
    private readonly now: () => number,
    startTs: number,
  ) {
    this.ts = startTs;
    const sessions = 3;
    for (let s = 0; s < sessions; s++)
      TEMPLATES.forEach((t, i) => {
        if (s > 0 && i === 3) return; // only the first session asks who it is
        const q: Q = {
          session: s,
          queryId: i + 1,
          t,
          digest: (0x1a2b3c4d5e6f + i * 7919).toString(16).slice(0, 12),
          // the first session ran each query; the others reused its runs
          cached: s > 0,
          history: [],
          at: now() - 60_000,
          docs: 1 + Math.floor(rnd.next() * 40),
        };
        if (s === 0) q.history.push({ kind: "rerun", at: now() - 60_000, reason: "newSubscriber" });
        this.queries.push(q);
      });
    for (let i = 0; i < 12; i++) this.step();
  }

  /** A commit writes into one template's range: every query of it is invalidated. */
  step(): InvalidationEvent[] {
    const t = TEMPLATES[Math.floor(this.rnd.next() * TEMPLATES.length)]!;
    this.ts += 1 + Math.floor(this.rnd.next() * 5);
    const id = `k${Math.floor(this.rnd.next() * 1e9)
      .toString(36)
      .padStart(8, "0")}x`;
    const vals = [...t.prefix, this.now() - 1000, id];
    const key: ReadBound = {
      kind: "key",
      values: vals,
      after: false,
      text: `[${vals.map((v) => (typeof v === "string" ? text(v) : String(v))).join(", ")}]`,
    };
    const seq = ++this.seq;
    const entry = {
      kind: "invalidation" as const,
      seq,
      at: this.now(),
      commitTs: this.ts,
      source: t.writer,
      table: t.index.split(".")[0]!,
      index: t.index,
      key,
      sentAfterMs: Math.round(this.rnd.next() * 300) / 100,
    };
    const out: InvalidationEvent[] = [];
    for (const q of this.queries.filter((x) => x.t === t)) {
      q.history.push(entry);
      if (q.history.length > HISTORY) q.history.shift();
      q.at = entry.at;
    }
    out.push({ ...entry, path: t.path, argsDigest: this.queries.find((q) => q.t === t)!.digest });
    return out;
  }

  private matches = (path: string, f?: InspectorFilter) => !f?.path || path.includes(f.path);

  snapshot(f?: InspectorFilter): SubscriptionsSnapshot {
    const sessions: LiveSession[] = [];
    const ids = [...new Set(this.queries.map((q) => q.session))];
    let total = 0;
    for (const s of ids) {
      const queries: LiveQuery[] = this.queries
        .filter((q) => q.session === s && this.matches(q.t.path, f))
        .map((q) => ({
          queryId: q.queryId,
          path: q.t.path,
          argsDigest: q.digest,
          ts: this.ts,
          cached: q.cached,
          lastRunAt: q.at,
          result: "value",
          documentsRead: q.docs,
          bytesRead: q.docs * 180,
          readSet: [range(q.t)],
          history: [...q.history].reverse(),
        }));
      total += queries.length;
      if (queries.length || !f?.path)
        sessions.push({
          sessionId: `0000000${s}-5e55-4a1d-9c0b-00000000000${s}`,
          identity: s === 0 ? "user" : "none",
          queries,
        });
    }
    return { ts: this.ts, historySize: HISTORY, sessions, totals: { sessions: ids.length, queries: total } };
  }

  cache(f?: InspectorFilter & { limit?: number }): QueryCacheSnapshot {
    const entries: QueryCacheEntry[] = TEMPLATES.map((t, i) => ({
      path: t.path,
      argsDigest: (0x1a2b3c4d5e6f + i * 7919).toString(16).slice(0, 12),
      shared: t.path !== "users:me",
      state: "ready" as const,
      size: 900 + ((i * 3_517) % 9_000),
      originalTs: this.ts - 4,
      tokenTs: this.ts,
      readSet: [range(t)],
    }));
    const shown = entries.filter((e) => this.matches(e.path, f)).sort((a, b) => b.size - a.size);
    const misses = Object.values(this.misses).reduce((a, b) => a + b, 0);
    return {
      entries: entries.length,
      bytes: entries.reduce((n, e) => n + e.size, 0),
      maxBytes: 100 * 1024 * 1024,
      hits: this.hits,
      misses,
      missReasons: { ...this.misses },
      evictions: this.evictions,
      matching: shown.length,
      biggest: shown.slice(0, f?.limit ?? 20),
    };
  }
}

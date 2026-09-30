// The mock's audit log (UI-01 §14.5, STUDY-12 §9): events with Convex's action names, a few from the past
// (deploys, index builds, the variables' creation), then whatever the mock's writes record.
import type { AuditEvent, AuditEventQuery, Json, Page, Value } from "../data-source.ts";
import type { Random } from "./random.ts";

export type AuditHost = {
  rnd: Random;
  paginate: <T>(
    items: T[],
    key: (t: T) => Value[],
    q: { numItems: number; cursor: string | null },
    query: string,
  ) => Page<T>;
};

/** Who the mock's credential is, as an event's author. */
export const MOCK_AUTHOR = "admin key";

export class MockAudit {
  private events: AuditEvent[] = [];
  private readonly watchers = new Set<() => void>();
  private seq = 0;

  constructor(
    private readonly host: AuditHost,
    now: number,
    sample = true,
  ) {
    if (!sample) return;
    const day = 86_400_000;
    const past: [number, string, { [key: string]: Json }][] = [
      [20 * day, "push_config", { modules: 4, functions: 11 }],
      [20 * day, "build_indexes", { added: ["tasks.by_owner", "messages.by_channel"] }],
      [19 * day, "create_environment_variable", { variable_name: "AUTH_SECRET" }],
      [19 * day, "create_environment_variable", { variable_name: "SITE_URL" }],
      [12 * day, "push_config", { modules: 4, functions: 11 }],
      [6 * day, "add_documents", { table: "imports", count: 12 }],
      [3 * day, "update_environment_variable", { variable_name: "LOG_LEVEL" }],
      [2 * day, "delete_documents", { table: "messages", count: 3 }],
      [1 * day, "push_config", { modules: 4, functions: 11 }],
    ];
    for (const [ago, action, metadata] of past)
      this.record(action, metadata, now - ago + host.rnd.int(0, 3_600_000), false);
  }

  /** Not part of the contract: records an event (the mock's writes call it). */
  record(action: string, metadata: { [key: string]: Json }, time: number, notify = true) {
    this.seq++;
    this.events.push({ id: `evt${String(this.seq).padStart(8, "0")}`, time, action, author: MOCK_AUTHOR, metadata });
    this.events.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
    if (notify && this.watchers.size > 0)
      setTimeout(() => {
        for (const w of this.watchers) w();
      }, 0);
  }

  list(q: AuditEventQuery): Page<AuditEvent> {
    const actions = q.actions ? [...q.actions].sort() : null;
    const rows = this.events
      .filter(
        (e) =>
          (q.from === undefined || e.time >= q.from) &&
          (q.to === undefined || e.time <= q.to) &&
          (actions === null || actions.includes(e.action)),
      )
      .reverse()
      .map((e) => ({ ...e, metadata: structuredClone(e.metadata) }));
    return this.host.paginate(
      rows,
      // newest first: time, then the later-recorded first (the id holds the sequence number)
      (e) => [-e.time, -Number(e.id.slice(3))],
      q,
      `audit\u0000${q.from ?? ""}\u0000${q.to ?? ""}\u0000${actions?.join(",") ?? "*"}`,
    );
  }

  watch(onChange: () => void): () => void {
    this.watchers.add(onChange);
    return () => this.watchers.delete(onChange);
  }
}

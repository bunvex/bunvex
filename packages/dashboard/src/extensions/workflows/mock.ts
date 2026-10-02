// The Workflows extension's mock (UI-01 §26.3): a few workflows with realistic journals — sequential steps, a
// parallel group, sleeps, an awaited event, retries — runs that succeeded, failed, were canceled or still run,
// and three work pools. Cancel, rerun and restart change the runs as a server would.
import type { Page, Value } from "../../data-source.ts";
import type { Random } from "../../mock/random.ts";
import type {
  RunStatus,
  StepKind,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunQuery,
  WorkflowStep,
  Workpool,
} from "./data-source.ts";

const MIN = 60_000;
type Template = { workflow: string; steps: { kind: StepKind; name: string; group: number; ms: number }[] };

const TEMPLATES: Template[] = [
  {
    workflow: "onboarding:welcome",
    steps: [
      { kind: "mutation", name: "users:createProfile", group: 0, ms: 40 },
      { kind: "action", name: "emails:sendWelcome", group: 1, ms: 900 },
      { kind: "action", name: "crm:syncContact", group: 1, ms: 1400 },
      { kind: "sleep", name: "sleep", group: 2, ms: 3 * 86_400_000 },
      { kind: "query", name: "users:activity", group: 3, ms: 30 },
      { kind: "action", name: "emails:sendNudge", group: 4, ms: 800 },
    ],
  },
  {
    workflow: "billing:monthlyInvoice",
    steps: [
      { kind: "query", name: "billing:usage", group: 0, ms: 60 },
      { kind: "action", name: "stripe:createInvoice", group: 1, ms: 2100 },
      { kind: "event", name: "invoicePaid", group: 2, ms: 6 * 3_600_000 },
      { kind: "mutation", name: "billing:markPaid", group: 3, ms: 35 },
    ],
  },
  {
    workflow: "ai:summarizeDocument",
    steps: [
      { kind: "query", name: "documents:get", group: 0, ms: 20 },
      { kind: "action", name: "llm:chunk", group: 1, ms: 700 },
      { kind: "action", name: "llm:summarizePart", group: 2, ms: 4200 },
      { kind: "action", name: "llm:summarizePart", group: 2, ms: 3900 },
      { kind: "action", name: "llm:summarizePart", group: 2, ms: 4600 },
      { kind: "workflow", name: "ai:refineSummary", group: 3, ms: 9000 },
      { kind: "mutation", name: "documents:saveSummary", group: 4, ms: 40 },
    ],
  },
  {
    workflow: "imports:csv",
    steps: [
      { kind: "action", name: "storage:download", group: 0, ms: 1200 },
      { kind: "action", name: "imports:parse", group: 1, ms: 2600 },
      { kind: "mutation", name: "imports:insertBatch", group: 2, ms: 300 },
      { kind: "mutation", name: "imports:finish", group: 3, ms: 30 },
    ],
  },
];

const ERRORS = [
  "Error: fetch failed (ECONNRESET)",
  "Error: rate limited by the provider (429)",
  "Error: timed out after 60 s",
];

type Stored = { run: WorkflowRun; journal: WorkflowStep[] };

export class MockWorkflows {
  private readonly runs: Stored[] = [];
  private seq = 0;

  constructor(
    private readonly rnd: Random,
    private readonly now: () => number,
  ) {
    const t0 = now();
    for (let i = 0; i < 48; i++) {
      const tpl = TEMPLATES[i % TEMPLATES.length]!;
      const at = t0 - Math.floor(rnd.next() * 2 * 86_400_000) - MIN;
      const roll = rnd.next();
      const outcome: RunStatus = i < 3 ? "running" : roll < 0.7 ? "success" : roll < 0.88 ? "failed" : "canceled";
      this.runs.push(this.make(tpl, at, outcome, { user: `u_${rnd.id().slice(0, 8)}` }));
    }
    this.runs.sort((a, b) => b.run.startedAt - a.run.startedAt);
  }

  private make(tpl: Template, at: number, outcome: RunStatus, args: Value, from = 0, replay?: WorkflowStep[]): Stored {
    const rnd = this.rnd;
    const id = `wf_${(++this.seq).toString(36)}${rnd.id().slice(0, 6)}`;
    const groups = [...new Set(tpl.steps.map((s) => s.group))];
    // where it stops: the last group for success; a random later group otherwise
    const stopAt = outcome === "success" ? groups.length : rnd.int(Math.min(1, groups.length - 1), groups.length - 1);
    let t = at;
    let retries = 0;
    const journal: WorkflowStep[] = [];
    for (const g of groups) {
      const inGroup = tpl.steps.map((s, index) => ({ s, index })).filter((x) => x.s.group === g);
      let groupEnd = t;
      for (const { s, index } of inGroup) {
        const replayed = replay && index < from ? replay[index] : undefined;
        if (replayed) {
          journal.push({ ...replayed });
          continue;
        }
        const before = g < stopAt;
        const here = g === stopAt;
        let status: WorkflowStep["status"] = before
          ? "success"
          : here
            ? outcome === "running"
              ? "running"
              : outcome
            : "pending";
        if (outcome === "success") status = "success";
        const attempts = s.kind === "action" && (status === "failed" || rnd.chance(0.2)) ? rnd.int(2, 4) : 1;
        retries += attempts - 1;
        const dur = Math.round(s.ms * (0.6 + rnd.next() * 0.8));
        const started = status === "pending" ? null : t;
        const finished = status === "success" || status === "failed" || status === "canceled" ? t + dur : null;
        if (status === "running" && attempts > 1 && s.kind === "action") status = "retrying";
        groupEnd = Math.max(groupEnd, finished ?? t);
        journal.push({
          index,
          kind: s.kind,
          name: s.name,
          group: g,
          status,
          startedAt: started,
          finishedAt: finished,
          attempts,
          args:
            s.kind === "sleep"
              ? { ms: s.ms }
              : s.kind === "event"
                ? { name: s.name }
                : { ...(args as object), step: index },
          ...(status === "success"
            ? {
                result:
                  s.kind === "query"
                    ? { count: rnd.int(1, 40) }
                    : s.kind === "sleep" || s.kind === "event"
                      ? null
                      : { ok: true },
              }
            : {}),
          ...(status === "failed" ? { error: rnd.pick(ERRORS) } : {}),
        });
      }
      t = groupEnd;
    }
    journal.sort((a, b) => a.index - b.index);
    const finished = outcome === "running" ? null : Math.max(...journal.map((s) => s.finishedAt ?? 0), at);
    const current = journal.find((s) => s.status === "running" || s.status === "retrying");
    const failedStep = journal.find((s) => s.status === "failed");
    const run: WorkflowRun = {
      id,
      workflow: tpl.workflow,
      status: outcome,
      startedAt: at,
      finishedAt: finished,
      currentStep: current?.name ?? null,
      steps: journal.length,
      retries,
      args,
      ...(outcome === "success" ? { result: { done: true } } : {}),
      ...(outcome === "failed" ? { error: failedStep?.error ?? ERRORS[0] } : {}),
    };
    return { run, journal };
  }

  list(q: WorkflowRunQuery): Page<WorkflowRun> {
    const rows = this.runs
      .filter((r) => (q.status ? r.run.status === q.status : true))
      .filter((r) => (q.workflow ? r.run.workflow === q.workflow : true))
      .map((r) => r.run);
    const start = q.cursor ? Number(q.cursor) : 0;
    const end = start + q.numItems;
    return { page: structuredClone(rows.slice(start, end)), isDone: end >= rows.length, continueCursor: String(end) };
  }

  get(id: string): WorkflowRunDetail | null {
    const r = this.runs.find((x) => x.run.id === id);
    return r ? structuredClone(r) : null;
  }

  names(): string[] {
    return [...new Set(this.runs.map((r) => r.run.workflow))].sort();
  }

  private find(id: string) {
    const r = this.runs.find((x) => x.run.id === id);
    if (!r) throw new Error(`no workflow run ${id}`);
    return r;
  }

  cancel(id: string) {
    const r = this.find(id);
    if (r.run.status !== "running") throw new Error(`run ${id} is ${r.run.status}, not running`);
    const t = this.now();
    for (const s of r.journal) {
      if (s.status === "running" || s.status === "retrying" || s.status === "pending") {
        s.status = "canceled";
        s.finishedAt = s.startedAt === null ? null : t;
      }
    }
    r.run.status = "canceled";
    r.run.finishedAt = t;
    r.run.currentStep = null;
  }

  rerun(id: string): string {
    const r = this.find(id);
    const tpl = TEMPLATES.find((x) => x.workflow === r.run.workflow)!;
    const next = this.make(tpl, this.now(), "running", r.run.args);
    this.runs.unshift(next);
    return next.run.id;
  }

  restartFrom(id: string, stepIndex: number): string {
    const r = this.find(id);
    if (stepIndex < 0 || stepIndex >= r.journal.length) throw new Error(`run ${id} has no step ${stepIndex}`);
    const tpl = TEMPLATES.find((x) => x.workflow === r.run.workflow)!;
    const next = this.make(tpl, this.now(), "running", r.run.args, stepIndex, r.journal);
    this.runs.unshift(next);
    return next.run.id;
  }

  pools(): Workpool[] {
    const t = this.now();
    const rnd = this.rnd;
    const pool = (name: string, max: number, load: number, failRate: number, retryByDefault: boolean): Workpool => {
      const running = Math.min(max, Math.round(max * load));
      return {
        name,
        maxParallelism: max,
        running,
        pending: load > 0.9 ? rnd.int(4, 40) : 0,
        backingOff: rnd.int(0, 3),
        succeeded: rnd.int(800, 9000),
        failed: rnd.int(5, 120),
        canceled: rnd.int(0, 12),
        retry: { maxAttempts: retryByDefault ? 5 : 3, initialBackoffMs: retryByDefault ? 250 : 1000, base: 2 },
        retryByDefault,
        throughput: Array.from({ length: 30 }, (_, i) => {
          const completed = Math.max(0, Math.round(max * 6 * load + (rnd.next() - 0.5) * max * 3));
          return { time: t - (29 - i) * MIN, completed, failed: rnd.chance(failRate) ? rnd.int(1, 3) : 0 };
        }),
      };
    };
    return [pool("emails", 10, 0.6, 0.15, true), pool("llm", 5, 1, 0.35, true), pool("imports", 1, 0.3, 0.05, false)];
  }
}

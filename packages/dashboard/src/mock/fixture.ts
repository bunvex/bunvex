// The mock deployment's data: a few tables of plausible documents, a function registry of every kind, and
// a history of function logs. Deterministic for a given seed and `now`.
import type {
  DeploymentInfo,
  Document,
  FunctionInfo,
  FunctionKind,
  IndexInfo,
  LogEntry,
  LogLevel,
} from "../data-source.ts";
import { encodeInt64 } from "../filters.ts";
import { MOCK_VALIDATORS } from "./function-validators.ts";
import { createRandom, type Random } from "./random.ts";

export type FixtureTable = { name: string; indexes: IndexInfo[]; documents: Document[]; declared: boolean };

export type Fixture = {
  deployment: DeploymentInfo;
  tables: FixtureTable[];
  functions: FunctionInfo[];
  /** In id order (oldest first). */
  logs: LogEntry[];
};

export type FixtureOptions = {
  seed?: number;
  /** The wall-clock ms the history ends at. Default: the current time. */
  now?: number;
  /** Documents per table. Default: users 40, tasks 1 000, messages 400, imports 12. */
  documents?: Partial<Record<"users" | "tasks" | "messages" | "imports", number>>;
  /** Function executions in the log history (each writes 1–4 lines). Default 800. */
  executions?: number;
  /** `false`: a deployment with no tables yet (the Database screen's empty state). Default true. */
  tables?: boolean;
};

export const SYSTEM_INDEXES: IndexInfo[] = [
  { name: "by_id", fields: ["_id"], system: true, state: "ready" },
  { name: "by_creation_time", fields: ["_creationTime"], system: true, state: "ready" },
];
const index = (name: string, ...fields: string[]): IndexInfo => ({ name, fields, system: false, state: "ready" });

const FIRST = ["Ada", "Alan", "Barbara", "Edsger", "Frances", "Grace", "Ken", "Leslie", "Margaret", "Radia"];
const LAST = ["Lovelace", "Turing", "Liskov", "Dijkstra", "Allen", "Hopper", "Thompson", "Lamport", "Hamilton"];
const VERBS = ["Write", "Review", "Ship", "Fix", "Measure", "Document", "Refactor", "Benchmark", "Deploy"];
const THINGS = ["the committer", "group commit", "the query cache", "index backfill", "the sync protocol"];
const CHANNELS = ["general", "engine", "dashboard", "random"];
const WORDS = "the commit is durable once its group is fsynced and every earlier group is too".split(" ");

export const MOCK_FUNCTIONS: FunctionInfo[] = [
  { path: "messages:list", kind: "query", visibility: "public" },
  { path: "messages:send", kind: "mutation", visibility: "public" },
  { path: "messages:purgeOld", kind: "mutation", visibility: "internal" },
  { path: "tasks:list", kind: "query", visibility: "public" },
  { path: "tasks:byOwner", kind: "query", visibility: "public" },
  { path: "tasks:create", kind: "mutation", visibility: "public" },
  { path: "tasks:toggle", kind: "mutation", visibility: "public" },
  { path: "tasks:summarize", kind: "action", visibility: "public" },
  { path: "users:get", kind: "query", visibility: "public" },
  { path: "users:upsert", kind: "mutation", visibility: "internal" },
  { path: "users:syncFromAuth", kind: "action", visibility: "internal" },
].map((f) => ({ ...f, ...MOCK_VALIDATORS[f.path] }) as FunctionInfo);

/** Creation times spread over the last `spanMs`, increasing, with a unique id each. */
function stamps(rnd: Random, n: number, now: number, spanMs: number) {
  const start = now - spanMs;
  const times = Array.from({ length: n }, () => start + rnd.next() * spanMs).sort((a, b) => a - b);
  return times.map((t) => ({ _id: rnd.id(), _creationTime: Math.round(t * 1000) / 1000 }));
}

function makeTables(rnd: Random, now: number, counts: FixtureOptions["documents"] = {}): FixtureTable[] {
  const day = 86_400_000;
  const users: Document[] = stamps(rnd, counts.users ?? 40, now - 30 * day, 60 * day).map((s) => {
    const name = `${rnd.pick(FIRST)} ${rnd.pick(LAST)}`;
    return {
      ...s,
      name,
      email: `${name.toLowerCase().replace(" ", ".")}@example.com`,
      admin: rnd.chance(0.1),
      // a 64-bit integer, to exercise the int64 encoding
      credits: encodeInt64(BigInt(rnd.int(0, 1_000_000)) * 10_000_000_000n),
    };
  });
  const owner = () => rnd.pick(users)._id;
  const tasks: Document[] = stamps(rnd, counts.tasks ?? 1000, now, 30 * day).map((s) => ({
    ...s,
    text: `${rnd.pick(VERBS)} ${rnd.pick(THINGS)}`,
    done: rnd.chance(0.4),
    owner: owner(),
    priority: rnd.int(1, 5),
    tags: rnd.chance(0.5) ? [rnd.pick(CHANNELS)] : [],
  }));
  const messages: Document[] = stamps(rnd, counts.messages ?? 400, now, 7 * day).map((s) => ({
    ...s,
    author: owner(),
    channel: rnd.pick(CHANNELS),
    body: Array.from({ length: rnd.int(3, 12) }, () => rnd.pick(WORDS)).join(" "),
    meta: rnd.chance(0.2) ? { edited: true, editedAt: s._creationTime + rnd.int(1000, 60_000) } : null,
  }));
  // written by a one-off script: not in the schema, fields vary, and one field holds bytes
  const imports: Document[] = stamps(rnd, counts.imports ?? 12, now, 2 * day).map((s) => {
    const doc: Document = { ...s, source: rnd.pick(["csv", "json", "api"]) };
    if (rnd.chance(0.5)) doc.rows = rnd.int(1, 5000);
    if (rnd.chance(0.5))
      doc.checksum = { $bytes: btoa(String.fromCharCode(...Array.from({ length: 8 }, () => rnd.int(0, 255)))) };
    return doc;
  });
  return [
    { name: "imports", indexes: [...SYSTEM_INDEXES], documents: imports, declared: false },
    {
      name: "messages",
      indexes: [...SYSTEM_INDEXES, index("by_channel", "channel")],
      documents: messages,
      declared: true,
    },
    {
      name: "tasks",
      indexes: [
        ...SYSTEM_INDEXES,
        index("by_owner", "owner"),
        index("by_done_priority", "done", "priority"),
        // just added to the schema: still being filled
        { ...index("by_text", "text"), state: "backfilling", progress: { indexed: 610, total: tasks.length } },
      ],
      documents: tasks,
      declared: true,
    },
    { name: "users", indexes: [...SYSTEM_INDEXES, index("by_email", "email")], documents: users, declared: true },
  ];
}

/** A log id: a zero-padded sequence number, so string order is creation order. */
export const logId = (n: number) => n.toString().padStart(12, "0");

/**
 * The lines one function execution writes. `seq` is the next log sequence number. `run` picks the function
 * and says whether it throws (a run from the dashboard); otherwise both are random.
 */
export function makeExecution(
  rnd: Random,
  seq: number,
  time: number,
  run?: { fn: FunctionInfo; error?: string },
  within?: { requestId: string; parentExecutionId: string },
): LogEntry[] {
  const fn = run?.fn ?? rnd.pick(MOCK_FUNCTIONS);
  const requestId = within?.requestId ?? rnd.id().slice(0, 16);
  const executionId = rnd.id().slice(0, 16);
  const failed = run ? run.error !== undefined : rnd.chance(fn.kind === "action" ? 0.08 : 0.03);
  const durationMs = fn.kind === "action" ? rnd.int(20, 900) : rnd.int(0, 40);
  const lines: { level: LogLevel; message: string }[] = [];
  if (rnd.chance(0.3)) lines.push({ level: "debug", message: `args ${JSON.stringify({ limit: rnd.int(1, 50) })}` });
  if (rnd.chance(0.4)) lines.push({ level: "info", message: `${rnd.pick(VERBS).toLowerCase()} ${rnd.pick(THINGS)}` });
  if (rnd.chance(0.1)) lines.push({ level: "warn", message: "retrying after an OCC conflict" });
  lines.push(
    failed
      ? {
          level: "error",
          message: run?.error ?? `Uncaught Error: ${rnd.pick(["document not found", "invalid argument", "timeout"])}`,
        }
      : { level: "info", message: fn.kind === "query" ? "query ran" : `${fn.kind} committed` },
  );
  const entry = (l: { level: LogLevel; message: string }, n: number, t: number): LogEntry => ({
    id: logId(n),
    time: t,
    level: l.level,
    message: l.message,
    function: { path: fn.path, kind: fn.kind as FunctionKind },
    requestId,
    executionId,
    ...(within && { parentExecutionId: within.parentExecutionId }),
  });
  const out = lines.slice(0, -1).map((l, i) => entry(l, seq + i, time + i));
  // an action may call queries and mutations: their executions sit inside it, in the same request
  if (fn.kind === "action" && !within && rnd.chance(0.6)) {
    const callable = MOCK_FUNCTIONS.filter((f) => f.kind !== "action");
    for (let k = rnd.int(1, 2); k > 0; k--)
      out.push(
        ...makeExecution(
          rnd,
          seq + out.length,
          time + out.length,
          { fn: rnd.pick(callable) },
          { requestId, parentExecutionId: executionId },
        ),
      );
  }
  const last = entry(lines.at(-1)!, seq + out.length, time + out.length);
  last.execution = { status: failed ? "failure" : "success", durationMs };
  return [...out, last];
}

export function createFixture(opts: FixtureOptions = {}): Fixture {
  const rnd = createRandom(opts.seed ?? 1);
  const now = opts.now ?? Date.now();
  const tables = opts.tables === false ? [] : makeTables(rnd, now, opts.documents);
  const executions = opts.executions ?? 800;
  const logs: LogEntry[] = [];
  const span = 6 * 3_600_000;
  for (let i = 0; i < executions; i++) {
    const time = Math.round(now - span + (span * i) / executions);
    logs.push(...makeExecution(rnd, logs.length + 1, time));
  }
  return {
    deployment: {
      name: "local",
      version: "0.0.0-mock",
      persistence: "memory",
      url: "http://127.0.0.1:3210",
      httpActionsUrl: "http://127.0.0.1:3211",
    },
    tables,
    functions: MOCK_FUNCTIONS,
    logs,
  };
}

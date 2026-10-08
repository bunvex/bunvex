// Everything the site says that could go stale — numbers, links, lists, code — in one place, so each can be
// checked against its source in the repository (test/content.test.ts, SITE-01 §5).

export const SITE = {
  url: "https://bunvex.dev",
  repo: "https://github.com/bunvex/bunvex",
  title: "bunvex — the reactive backend, built for Bun",
  description:
    "Write queries and mutations in TypeScript; every client sees changes the moment they commit. Convex's API on its own database engine, on SQLite, Postgres, MySQL or MongoDB. Pre-alpha.",
} as const;

/** A link to a file of the repository on GitHub. */
export const blob = (path: string) => `${SITE.repo}/blob/main/${path}`;
/** A link to a directory of the repository on GitHub. */
export const tree = (path: string) => `${SITE.repo}/tree/main/${path}`;

export const EXAMPLES = tree("examples");

export const HERO = {
  /** The pill above the headline: the share of Convex's inventory that is done (PARITY below). */
  pill: "of Convex's surface, checked row by row",
  headline: ["The reactive backend,", "built for Bun."],
  subline:
    "Write queries and mutations in TypeScript. Every client sees changes the moment they commit. Convex's API on its own database engine, running on SQLite, Postgres, MySQL or MongoDB.",
} as const;

/** Each line is a command of packages/cli/README.md (bun) or docker/README.md (docker, binary). */
export const INSTALL = [
  {
    id: "bun",
    label: "bun",
    lines: ["bun add @bunvex/server @bunvex/values", "bun add -d @bunvex/cli", "bunx bunvex dev"],
  },
  { id: "docker", label: "docker", lines: ["docker compose up"] },
  {
    id: "binary",
    label: "binary",
    lines: ['./bunvex-local-backend --instance-name bunvex-self-hosted --instance-secret "$INSTANCE_SECRET"'],
  },
] as const;

/** The hero's two-tab chat: messages typed in one tab appear in both. */
export const DEMO = {
  people: ["Ana", "Bruno"] as const,
  seed: [
    { who: "Bruno", text: "morning!" },
    { who: "Ana", text: "hey" },
  ],
  script: [
    { who: "Ana", text: "did the deploy go through?" },
    { who: "Bruno", text: "yes, 3 functions pushed" },
    { who: "Ana", text: "I can see your message already" },
    { who: "Bruno", text: "no refresh, no polling" },
  ],
} as const;

export type BenchRow = { metric: string; convex: string; postgres: string; sqlite: string };

/** docs/bench/E2E-VPS-2026-10-05.md — the same 2-vCPU VPS and harness; Convex ran on the Postgres bunvex used. */
export const BENCH = {
  rows: [
    { metric: "uncached indexed read, req/s", convex: "282", postgres: "1 337", sqlite: "1 787" },
    { metric: "durable insert, req/s", convex: "406", postgres: "3 281", sqlite: "2 494" },
    { metric: "action (query + mutation), req/s", convex: "134", postgres: "1 159", sqlite: "1 544" },
    { metric: "cached read, req/s", convex: "4 299", postgres: "5 925", sqlite: "6 499" },
    {
      metric: "10 000 subscribers, splay off, delivered · p99",
      convex: "OOM (6.7 GB)",
      postgres: "100 % · 1.57 s",
      sqlite: "100 % · 825 ms",
    },
  ] satisfies BenchRow[],
  /** The short tab names of the rows, in the same order. */
  tabs: ["Uncached read", "Durable insert", "Action", "Cached read", "10 000 subscribers"],
  caption:
    "Measured 5 Oct 2026 on a 2-vCPU VPS. Convex self-hosted ran on Postgres 17, the same instance as bunvex on Postgres; bunvex on SQLite uses the built-in bun:sqlite. The fan-out row compares both with wide invalidations not spread over time (Convex's from 29 Sep).",
  reading: "Higher requests per second and delivery are better; lower p99 latency is better.",
  report: blob("docs/bench/E2E-VPS-2026-10-05.md"),
} as const;

// scripts/check-deps.ts reads any `from "x"` in a source file as an import, even inside a string, so the
// samples quote their module names through `q`.
const q = (module: string) => `"${module}"`;

/** examples/tutorial: messages.ts is the file as it is; App.tsx keeps its lines, with some left out. */
export const FILES = {
  source: tree("examples/tutorial"),
  files: [
    {
      name: "messages.ts",
      path: "examples/tutorial/bunvex/messages.ts",
      whole: true,
      code: `import { v } from ${q("bunvex/values")};
import { mutation, query } from ${q("./_generated/server")};

/** The 50 most recent messages, oldest first. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const messages = await ctx.db.query("messages").order("desc").take(50);
    return messages.reverse();
  },
});

/** Post a message. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author });
  },
});
`,
    },
    {
      name: "App.tsx",
      path: "examples/tutorial/src/App.tsx",
      whole: false,
      code: `import { useMutation, useQuery } from ${q("bunvex/react")};
import { api } from ${q("../bunvex/_generated/api")};

export function App() {
  // Live: every message anyone sends shows up here, with no refresh.
  const messages = useQuery(api.messages.list);
  const send = useMutation(api.messages.send);
  …
      <ul>
        {messages?.map((m) => (
          <li key={m._id}>
            <strong>{m.author}:</strong> {m.body}
          </li>
        ))}
      </ul>
`,
    },
  ],
  /** What the two files leave out, each with the study that builds it. */
  notWritten: [
    {
      gone: "WebSocket server and reconnect logic",
      note: "the client keeps one socket",
      source: "docs/study/STUDY-26-sync-client.md",
    },
    {
      gone: "Cache invalidation",
      note: "each query knows what it read",
      source: "docs/study/STUDY-08-cache-and-subscriptions.md",
    },
    {
      gone: "Locks and retry loops",
      note: "transactions are serializable",
      source: "docs/study/STUDY-06-transactions-and-occ.md",
    },
    { gone: "API types", note: "generated from your functions", source: "docs/study/STUDY-36-codegen.md" },
    {
      gone: "Index migrations",
      note: "new indexes backfill in the background",
      source: "docs/study/STUDY-29-index-backfill.md",
    },
  ],
} as const;

/** The feature grid. Each card links to the study that specifies it. */
export const FEATURES = [
  {
    tag: "reactive queries",
    title: "Subscriptions that re-run only when their data changes",
    body: "A query records the key ranges it read. A commit wakes exactly the subscriptions whose ranges it touched, and every query of a client advances to the same point in time.",
    snippet: "const tasks = useQuery(api.tasks.list, { done: false });",
    source: "docs/study/STUDY-08-cache-and-subscriptions.md",
    wide: true,
  },
  {
    tag: "transactions",
    title: "Serializable, without locks",
    body: "Optimistic transactions validated by one committer. No lost updates; writes to different documents never conflict.",
    source: "docs/study/STUDY-06-transactions-and-occ.md",
  },
  {
    tag: "scheduler",
    title: "Jobs and crons",
    body: "Schedule a function from a mutation: the job exists only if the mutation commits.",
    snippet: "ctx.scheduler.runAfter(5000, …)",
    source: "docs/study/STUDY-30-scheduler-and-crons.md",
  },
  {
    tag: "search",
    title: "Full-text and vector",
    body: "BM25 text search and vector indexes, read in the same transaction as everything else.",
    source: "docs/study/STUDY-45-text-search.md",
  },
  {
    tag: "storage",
    title: "Files, on disk or S3",
    body: "Upload, serve and delete files, on a local disk or any S3-compatible store.",
    source: "docs/study/STUDY-32-file-storage.md",
  },
  {
    tag: "auth",
    title: "Your identity provider",
    body: "Any OIDC provider or custom JWT, with ready-made Clerk and Auth0 providers for React.",
    source: "docs/study/STUDY-27-auth.md",
  },
  {
    tag: "http actions",
    title: "Webhooks and APIs",
    body: "HTTP routes defined next to your functions, with streamed bodies.",
    source: "docs/study/STUDY-31-http-actions.md",
  },
  {
    tag: "cli",
    title: "dev, deploy, run, logs",
    body: "Codegen, environment variables, snapshot import and export, and an MCP server for AI tools.",
    source: "packages/cli/README.md",
  },
  {
    tag: "observability",
    title: "Metrics, traces and log streams",
    body: "Prometheus metrics, OpenTelemetry traces down to each index read, and log sinks for Datadog, Axiom, Sentry and webhooks.",
    source: "docs/study/STUDY-131-debugging-and-observability.md",
    half: true,
  },
  {
    tag: "coming",
    title: "A dashboard for your data",
    body: "Tables, functions, logs and schedules. Every screen is built; the connection to a live deployment is next.",
    source: "packages/dashboard/README.md",
    half: true,
    soon: true,
  },
] as const;

export const DRIVERS = [
  { name: "SQLite", note: "built in, bun:sqlite" },
  { name: "Postgres", note: "TLS verified by default" },
  { name: "MySQL", note: "Convex's table layout" },
  { name: "MongoDB", note: "on a replica set" },
  { name: "memory + log", note: "built in, no dependency" },
] as const;

export const CONFORMANCE = {
  text: "Every driver passes the public PERSIST-01 conformance suite in CI, so you can write your own.",
  link: blob("docs/specs/PERSIST-01-contract.md"),
} as const;

/** The three ways to run a deployment: packages/cli, docker/, the release executable (STUDY-39). */
export const SHIP = [
  { command: "bunvex dev", text: "a local deployment that redeploys on every save" },
  { command: "docker compose up", text: "the self-hosted image, with its credentials generated" },
  { command: "bunvex-local-backend", text: "one executable for Linux, macOS and Windows" },
] as const;

export const MIGRATE = {
  facts: [
    { text: "The official client talks to bunvex: the same sync protocol.", source: "packages/client/README.md" },
    { text: "Snapshots exported from one import into the other.", source: "docs/study/STUDY-42-import-export.md" },
    { text: "21 example apps after Convex's demos, each tested end to end.", source: "examples/README.md" },
    {
      text: "The same apps run on Convex's own backend every night, and the results are compared.",
      source: "docs/study/STUDY-122-differential-testing.md",
    },
  ],
  /** Two module names on each side of the diff. */
  diff: [
    { from: `import { query } from ${q("convex/server")};`, to: `import { query } from ${q("bunvex/server")};` },
    { from: `import { useQuery } from ${q("convex/react")};`, to: `import { useQuery } from ${q("bunvex/react")};` },
    { from: "npx convex dev", to: "bunx bunvex dev" },
  ],
} as const;

/** docs/parity/README.md's summary table: done, partial and missing rows per area. */
export const PARITY = {
  areas: [
    { name: "Function and database API", done: 233, partial: 3, missing: 10 },
    { name: "Clients, sync protocol, React", done: 161, partial: 2, missing: 2 },
    { name: "Platform: auth, storage, scheduler, CLI…", done: 213, partial: 28, missing: 22 },
  ],
  link: blob("docs/parity/README.md"),
} as const;

/** The share of all inventoried rows that are done, as a whole percentage. */
export const parityPercent = () => {
  const done = PARITY.areas.reduce((n, a) => n + a.done, 0);
  const all = PARITY.areas.reduce((n, a) => n + a.done + a.partial + a.missing, 0);
  return Math.floor((done / all) * 100);
};

/** docs/parity/README.md "Roadmap": the phase headings, and what each phase's status line says. */
export const STATUS = {
  phases: [
    { name: "Phase 0", summary: "correctness bugs in what already exists", done: true, left: "" },
    { name: "Phase 1", summary: "the core behaves like Convex", done: true, left: "" },
    { name: "Phase 2", summary: "sync protocol and clients", done: true, left: "" },
    { name: "Phase 3", summary: "platform", done: false, left: "dashboard, built-in auth left" },
    { name: "Phase 4", summary: "the rest", done: false, left: "components left" },
  ],
  parity: blob("docs/parity/README.md"),
} as const;

export const NOTICE =
  "bunvex is an independent implementation written from scratch. It is not affiliated with Convex, Inc.";

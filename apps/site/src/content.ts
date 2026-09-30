// Everything the site says that could go stale — numbers, links, lists — in one place, so each can be
// checked against its source in the repository (test/content.test.ts, SITE-01 §5).

export const SITE = {
  url: "https://bunvex.dev",
  repo: "https://github.com/bunvex/bunvex",
  title: "bunvex — the reactive backend of Convex, rewritten for Bun",
  description:
    "A Convex-style reactive backend for Bun with its own database engine: reactive queries, serializable transactions and pluggable persistence (SQLite, Postgres, MySQL, MongoDB). Pre-alpha.",
} as const;

/** A link to a file of the repository on GitHub. */
export const blob = (path: string) => `${SITE.repo}/blob/main/${path}`;

export const HERO = {
  headline: "The reactive backend of Convex, rewritten for Bun.",
  subline:
    "Its own database engine, serializable transactions, reactive queries and pluggable persistence — built so a Convex app behaves the same on it.",
} as const;

export type BenchRow = { metric: string; convex: string; postgres: string; sqlite: string };

/** docs/bench/E2E-VPS-2026-09-29.md — the same 2-vCPU VPS and harness; Convex ran on the Postgres bunvex used. */
export const BENCH = {
  rows: [
    { metric: "cached read, req/s", convex: "4 853", postgres: "8 951", sqlite: "8 140" },
    { metric: "uncached indexed read, req/s", convex: "298", postgres: "2 119", sqlite: "3 045" },
    { metric: "durable insert, req/s", convex: "427", postgres: "6 052", sqlite: "4 004" },
    { metric: "action (query + mutation), req/s", convex: "139", postgres: "2 492", sqlite: "3 395" },
    {
      metric: "10 000 subscribers, delivered · p99",
      convex: "5 % · 3.2 s",
      postgres: "100 % · 220 ms",
      sqlite: "100 % · 227 ms",
    },
  ] satisfies BenchRow[],
  caption:
    "Same 2-vCPU VPS, same harness. Convex self-hosted ran on Postgres 17 — the same instance as bunvex on Postgres; bunvex on SQLite uses the built-in bun:sqlite.",
  reading: "Higher requests per second and delivery are better; lower p99 latency is better.",
  report: blob("docs/bench/E2E-VPS-2026-09-29.md"),
} as const;

export const FEATURES = [
  {
    title: "Reactive queries",
    body: "Clients subscribe to query functions. A commit re-runs exactly the subscriptions whose read-set it touched, and pushes the new result.",
  },
  {
    title: "Serializable transactions",
    body: "Mutations run as optimistic transactions validated by a single committer: no lost updates, no false conflicts between writes to different documents.",
  },
  {
    title: "Pluggable persistence",
    body: "The engine keeps every document version and index entry in an ordered, versioned store — bring the database you already run.",
  },
] as const;

export const DRIVERS = [
  { name: "memory + log", note: "built in" },
  { name: "SQLite", note: "built in" },
  { name: "Postgres" },
  { name: "MySQL" },
  { name: "MongoDB" },
] as const;

export const CONFORMANCE = {
  text: "Every driver passes the public PERSIST-01 conformance suite, so you can write your own.",
  link: blob("docs/specs/PERSIST-01-contract.md"),
} as const;

// scripts/check-deps.ts reads any `from "x"` in a source file as an import, even inside a string, so the
// samples quote their module names through `q`.
const q = (module: string) => `"${module}"`;

export const CODE = {
  label: "Target API — Convex-compatible, landing in Phase 1.",
  files: [
    {
      name: "schema.ts",
      code: `import { defineSchema, defineTable } from ${q("bunvex/server")};
import { v } from ${q("bunvex/values")};

export default defineSchema({
  messages: defineTable({ room: v.string(), body: v.string() })
    .index("by_room", ["room"]),
});`,
    },
    {
      name: "messages.ts",
      code: `import { v } from ${q("bunvex/values")};
import { mutation, query } from ${q("bunvex/server")};

export const list = query({
  args: { room: v.string() },
  handler: (ctx, { room }) =>
    ctx.db
      .query("messages")
      .withIndex("by_room", (q) => q.eq("room", room))
      .collect(),
});

export const send = mutation({
  args: { room: v.string(), body: v.string() },
  handler: (ctx, message) => ctx.db.insert("messages", message),
});`,
    },
  ],
} as const;

/** README.md "Status" and docs/parity/README.md "Roadmap". */
export const STATUS = {
  works: ["The database engine", "Five persistence drivers", "The HTTP API", "WebSocket subscriptions"],
  next: ["The client SDK", "Validation", "Auth", "The scheduler", "The CLI"],
  phases: [
    { name: "Phase 0", summary: "correctness bugs in what already exists" },
    { name: "Phase 1", summary: "the core behaves like Convex" },
    { name: "Phase 2", summary: "sync protocol and clients" },
    { name: "Phase 3", summary: "platform" },
    { name: "Phase 4", summary: "the rest" },
  ],
  parity: blob("docs/parity/README.md"),
} as const;

export const NOTICE =
  "bunvex is an independent implementation written from scratch. It is not affiliated with Convex, Inc.";

// The dashboard's Schedules, Files, History and Health reads (STUDY-149 PR 5) on Convex's backend (the oracle) and
// on bunvex's: the system functions and routes `@bunvex/dashboard-source` calls, with the same requests, their
// answers compared after the ids, times and cursors are named by order of appearance. Each backend gets its own
// auth scheme and encoded format (`Convex <key>` / `Bunvex <key>`, DV-97; `convex_encoded_json` / `encoded_json`,
// DV-307). Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh,
// or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BunvexClient } from "bunvex/browser";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`dashboard-ops: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../dashboard-app");
const HOUR = 3_600_000;

let convex: Backend;
let bunvex: Backend;

const authOf = (b: Backend) => `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;

/** A system function over the HTTP API as an admin, in the backend's encoded format: its status and value. */
async function sys(b: Backend, kind: "query" | "mutation", path: string, args: unknown = {}) {
  const r = await fetch(`${b.url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: authOf(b) },
    body: JSON.stringify({ path, args, format: b.name === "convex" ? "convex_encoded_json" : "encoded_json" }),
  });
  const body = (await r.json()) as { status: string; value?: unknown; errorMessage?: string };
  // the error's request id and stack are each backend's own
  const error = body.errorMessage
    ?.replace(/^\[Request ID: \w+\] /, "")
    .replace(/\n {4}at [^\n]*/g, "")
    .replace(/^(Server Error\n)Uncaught Error: /, "$1");
  return body.status === "success" ? { value: body.value } : { error };
}

/** An admin route: its status and body. */
async function route(b: Backend, method: "GET" | "POST", path: string, body?: unknown) {
  const r = await fetch(`${b.url}${path}`, {
    method,
    headers: { authorization: authOf(b), ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: text === "" ? "" : (JSON.parse(text) as unknown) };
}

/**
 * Ids, times and cursors named by order of appearance; what each backend writes its own way left out: a page's
 * cursors, an int64 time (`{$integer}` under a time field), a float `_creationTime`, URLs' tokens.
 */
function normalize(value: unknown): unknown {
  const names = new Map<string, string>();
  const idName = (s: string) => {
    if (!names.has(s)) names.set(s, `id${names.size}`);
    return names.get(s)!;
  };
  const TIME = /^(_creationTime|nextTs|prevTs|ts|originalScheduledTs|completedTs|executionTime)$/;
  const walk = (v: unknown, key = ""): unknown => {
    if (TIME.test(key) && v !== null) return "<time>";
    if (key === "continueCursor" || key === "splitCursor") return "<cursor>";
    if (key === "url" && typeof v === "string") return "<url>";
    if (typeof v === "string" && /^[0-9a-z]{31,37}$/.test(v)) return idName(v);
    if (typeof v === "string") return v.replace(/\b[0-9a-z]{31,37}\b/g, idName);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value);
}

async function same(f: (b: Backend) => Promise<unknown>) {
  const [c, x] = [await f(convex), await f(bunvex)];
  expect(normalize(x)).toEqual(normalize(c));
  return c;
}

/** Stores a file through the URL `generateUploadUrl` gives, as the dashboard's uploader: its storage id. */
async function upload(b: Backend, body: string, type?: string) {
  const { value: url } = await sys(b, "mutation", "_system/frontend/fileStorageV2:generateUploadUrl");
  const r = await fetch(url as string, { method: "POST", body, ...(type && { headers: { "content-type": type } }) });
  return ((await r.json()) as { storageId: string }).storageId;
}

const window = () => {
  const end = Date.now() + 60_000;
  const t = (ms: number) => ({ secs_since_epoch: Math.floor(ms / 1000), nanos_since_epoch: 0 });
  return encodeURIComponent(JSON.stringify({ start: t(end - 10 * 60_000), end: t(end), num_buckets: 10 }));
};

describe.skipIf(!ready)("the dashboard's operations reads on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
    for (const b of [convex, bunvex]) {
      await b.call("mutation", "ops:schedule", { count: 3, delayMs: HOUR });
      await b.call("mutation", "ops:schedule", { count: 2, delayMs: 2 * HOUR, fn: "other" });
    }
  }, 300_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("scheduled runs: every page nearest first, one function's by its canonical path, a run's arguments", async () => {
    const page = (await same((b) =>
      sys(b, "query", "_system/frontend/paginatedScheduledJobs", { paginationOpts: { numItems: 10, cursor: null } }),
    )) as { value: { page: { argsId: string }[] } };
    expect(page.value.page.length).toBe(5);
    await same((b) =>
      sys(b, "query", "_system/frontend/paginatedScheduledJobs", {
        paginationOpts: { numItems: 2, cursor: null },
        udfPath: "ops.js:otherFn",
      }),
    );
    // the path matched exactly: the dashboard sends its function identifiers, `module.js:name`
    const display = await same((b) =>
      sys(b, "query", "_system/frontend/paginatedScheduledJobs", {
        paginationOpts: { numItems: 2, cursor: null },
        udfPath: "ops:otherFn",
      }),
    );
    expect((display as { value: { page: unknown[] } }).value.page).toEqual([]);
    await same(async (b) => {
      const p = await sys(b, "query", "_system/frontend/paginatedScheduledJobs", {
        paginationOpts: { numItems: 1, cursor: null },
      });
      const argsId = (p.value as { page: { argsId: string }[] }).page[0]!.argsId;
      return sys(b, "query", "_system/frontend/scheduler:getArgs", { argsId });
    });
  });

  test("cron jobs: their specs, last and next runs; the runs", async () => {
    const sorted = (r: { value?: unknown }) => ({
      value: [...(r.value as { name: string }[])].sort((a, b) => (a.name < b.name ? -1 : 1)),
    });
    await same(async (b) => sorted(await sys(b, "query", "_system/frontend/listCronJobs")));
    await same((b) => sys(b, "query", "_system/frontend/listCronJobRuns"));
  });

  test("cancelling: a bogus id, one run, all of a function's; the audit events", async () => {
    await same((b) => route(b, "POST", "/api/cancel_job", { id: "bogus" }));
    await same(async (b) => {
      const p = await sys(b, "query", "_system/frontend/paginatedScheduledJobs", {
        paginationOpts: { numItems: 1, cursor: null },
      });
      const id = (p.value as { page: { _id: string }[] }).page[0]!._id;
      return [await route(b, "POST", "/api/cancel_job", { id }), await route(b, "POST", "/api/cancel_job", { id })];
    });
    await same((b) => route(b, "POST", "/api/cancel_all_jobs", { udfPath: "ops:otherFn" }));
    await same((b) =>
      sys(b, "query", "_system/frontend/paginatedScheduledJobs", { paginationOpts: { numItems: 10, cursor: null } }),
    );
    await same(async (b) => {
      const p = await sys(b, "query", "_system/frontend/paginatedDeploymentEvents", {
        paginationOpts: { numItems: 3, cursor: null },
        filters: { minDate: 0, actions: ["cancel_scheduled_function", "cancel_all_scheduled_functions"] },
      });
      const page = (p.value as { page: Record<string, unknown>[] }).page;
      return page.map((e) => [e.action, e.member_id, e.metadata]);
    });
  });

  test("files: uploads, the list both ways and by time, the count, a file, deleting, the errors", async () => {
    await same(async (b) => {
      const ids = [await upload(b, "hello", "text/plain"), await upload(b, "{}", "application/json")];
      await upload(b, "raw");
      return ids;
    });
    for (const order of ["asc", "desc"])
      await same((b) =>
        sys(b, "query", "_system/frontend/fileStorageV2:fileMetadata", {
          paginationOpts: { numItems: 2, cursor: null },
          filters: { order },
        }),
      );
    await same((b) => sys(b, "query", "_system/frontend/fileStorageV2:numFiles"));
    await same(async (b) => {
      const id = await upload(b, "doomed", "text/csv");
      const job = (await b.call("mutation", "ops:schedule", { count: 1, delayMs: HOUR })).body as { value: string[] };
      return [
        await sys(b, "query", "_system/frontend/fileStorageV2:getFile", { storageId: id }),
        // not a storage id: null (Convex masks db.system.get); a scheduled function's id fails at its URL
        await sys(b, "query", "_system/frontend/fileStorageV2:getFile", { storageId: "no-such-file" }),
        await sys(b, "query", "_system/frontend/fileStorageV2:getFile", { storageId: job.value[0] }),
        await sys(b, "mutation", "_system/frontend/fileStorageV2:deleteFiles", { storageIds: [id, "no-such-file"] }),
        await sys(b, "mutation", "_system/frontend/fileStorageV2:deleteFiles", { storageIds: [id] }),
        await sys(b, "mutation", "_system/frontend/fileStorageV2:deleteFiles", { storageIds: [id] }),
        await sys(b, "query", "_system/frontend/fileStorageV2:getFile", { storageId: id }),
      ];
    });
    await same(async (b) => {
      const p = await sys(b, "query", "_system/frontend/paginatedDeploymentEvents", {
        paginationOpts: { numItems: 3, cursor: null },
        filters: { minDate: 0 },
      });
      return (p.value as { page: Record<string, unknown>[] }).page.map((e) => [e.action, e.member_id, e.metadata]);
    });
  });

  test("Health: the concurrency gauges by name; an app subscription's invalidation by mutation and table", async () => {
    await same(async (b) => {
      const r = await route(b, "GET", `/api/app_metrics/function_concurrency?window=${window()}`);
      return [r.status, Object.keys(r.body as object).sort()];
    });
    const invalidations = async (b: Backend) => {
      const list = makeFunctionReference<"query">("ops:list");
      const client =
        b.name === "convex"
          ? new ConvexClient(b.url)
          : (new BunvexClient(b.url, { logger: false }) as unknown as ConvexClient);
      let results = 0;
      const off = client.onUpdate(list, {}, () => results++);
      try {
        while (results === 0) await Bun.sleep(10);
        await b.call("mutation", "ops:send", { body: "invalidates" });
        while (results < 2) await Bun.sleep(10);
        const r = await route(b, "GET", `/api/app_metrics/subscription_invalidations_top_k?k=25&window=${window()}`);
        const one = await route(
          b,
          "GET",
          `/api/app_metrics/subscription_invalidations_top_k?k=25&udfPath=ops:send&udfType=Mutation&window=${window()}`,
        );
        const names = (x: { body: unknown }) => (x.body as [string, unknown][]).map(([n]) => n).sort();
        return { all: names(r), one: names(one) };
      } finally {
        off();
        await client.close();
      }
    };
    const [c, x] = [await invalidations(convex), await invalidations(bunvex)];
    expect(x.one).toEqual(c.one);
    expect(c.all).toContain("ops.js:send:messages");
    // the scheduler's and crons' own subscriptions counted too (DV-480, resolved to match Convex)
    expect(x.all).toEqual(c.all);
  });
});
/** Every pair of `subscription_invalidations_top_k` with its count over the last ten minutes. */
async function invalidationCounts(b: Backend) {
  const end = Date.now() + 60_000;
  const t = (ms: number) => ({ secs_since_epoch: Math.floor(ms / 1000), nanos_since_epoch: 0 });
  const w = encodeURIComponent(JSON.stringify({ start: t(end - 10 * 60_000), end: t(end), num_buckets: 1 }));
  const r = await route(b, "GET", `/api/app_metrics/subscription_invalidations_top_k?k=25&window=${w}`);
  return (r.body as [string, [unknown, number | null][]][]).map(([n, s]) => [n, s[0]?.[1]]).sort();
}

/** An int64 in the encoded format, as a bigint. */
const int64 = (v: { $integer: string }) =>
  new DataView(Uint8Array.from(atob(v.$integer), (ch) => ch.charCodeAt(0)).buffer).getBigInt64(0, true);

describe.skipIf(!ready)("Health's invalidations of a scheduling app, step by step (DV-480)", () => {
  let c: Backend;
  let x: Backend;
  beforeAll(async () => {
    [c, x] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
  }, 300_000);
  afterAll(async () => {
    await Promise.all([c?.stop(), x?.stop()]);
  });

  const first = async (b: Backend) => {
    const p = await sys(b, "query", "_system/frontend/paginatedScheduledJobs", {
      paginationOpts: { numItems: 1, cursor: null },
    });
    return (p.value as { page: { _id: string; nextTs: { $integer: string } }[] }).page[0];
  };
  /** The runs due by now have run. */
  const settled = async (b: Backend) => {
    for (let i = 0; i < 200; i++) {
      const job = await first(b);
      if (!job || int64(job.nextTs) > BigInt(Date.now()) * 1_000_000n) return;
      await Bun.sleep(50);
    }
  };
  const steps: [string, (b: Backend) => Promise<unknown>][] = [
    ["the deploy's cron run", async () => {}],
    ["a run scheduled on an empty queue", (b) => b.call("mutation", "ops:schedule", { count: 1, delayMs: HOUR })],
    [
      "the first future run canceled (outside the executor's read)",
      async (b) => expect((await route(b, "POST", "/api/cancel_job", { id: (await first(b))!._id })).status).toBe(200),
    ],
    [
      "a run scheduled on the empty queue again",
      (b) => b.call("mutation", "ops:schedule", { count: 1, delayMs: HOUR }),
    ],
    ["a later run (outside)", (b) => b.call("mutation", "ops:schedule", { count: 1, delayMs: 2 * HOUR })],
    ["a nearer run, which runs", (b) => b.call("mutation", "ops:schedule", { count: 1, delayMs: 300 })],
    ["two nearer runs, which run", (b) => b.call("mutation", "ops:schedule", { count: 2, delayMs: 300 })],
    ["every run canceled", (b) => route(b, "POST", "/api/cancel_all_jobs", {})],
  ];
  for (const [i, [name, step]] of steps.entries())
    test(`${i + 1}. ${name}`, async () => {
      for (const b of [c, x]) {
        await step(b);
        await Bun.sleep(400);
        await settled(b);
        await Bun.sleep(400);
      }
      expect(await invalidationCounts(x)).toEqual(await invalidationCounts(c));
    });
});

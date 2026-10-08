// `bunvex deployment usage` and `usage-limits list|set|remove` (STUDY-118) end to end against a running server
// (STUDY-61's routes): Convex's messages, tables, number formats, ordering, JSON and exit codes.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { formatTable } from "../src/deployment.ts";
import { type Io, main } from "../src/index.ts";

const SECRET = "ab".repeat(32);
const NAME = "usage-cli-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });
const PENDING =
  "Historical usage is still being loaded, so the usage shown below may understate this deployment's actual usage. Check back shortly for accurate totals.";

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-usage-"));
  dirs.push(dir);
  const engine = await new Engine(defineSchema({}), new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }), {
    instanceName: NAME,
    instanceSecret: SECRET,
    storedSchema: true,
  }).init();
  const s = createServer({ engine, functions: new Functions(engine), port: 0, usageLimitIntervalMs: 3_600_000 });
  stops.push(() => s.stop());
  const url = `http://127.0.0.1:${s.server.port}`;
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { env: {}, cwd: dir, out: (l) => out.push(l), err: (l) => err.push(l) };
    const key = args.includes("--read-only") ? READ_ONLY : KEY;
    const rest = args.filter((a) => a !== "--read-only");
    const code = await main(["deployment", ...rest, "--url", url, "--admin-key", key], io);
    return { code, out, err };
  };
  return { s, url, run };
}

const SET = ["usage-limits", "set"];
const FN_DAY_DISABLE = ["--metric", "functionCalls", "--window", "day", "--type", "disable"];

describe("bunvex deployment usage-limits", () => {
  test("set creates, then updates by (metric, window, type), with Convex's messages", async () => {
    const { run } = await deployment();
    expect(await run("usage-limits", "list")).toEqual({ code: 0, out: [], err: ["No usage limits configured."] });
    expect(await run(...SET, ...FN_DAY_DISABLE)).toEqual({
      code: 1,
      out: [],
      err: ["✖ error: --limit is required when creating a usage limit."],
    });
    const created = "disable usage limit on Function calls per day";
    expect(await run(...SET, ...FN_DAY_DISABLE, "--limit", "1000000")).toEqual({
      code: 0,
      out: [],
      err: [`✔ Created ${created}: 1,000,000, active.`],
    });
    expect((await run(...SET, ...FN_DAY_DISABLE, "--limit=2000000")).err).toEqual([
      `✔ Updated ${created}: limit 1,000,000 → 2,000,000.`,
    ]);
    expect((await run(...SET, ...FN_DAY_DISABLE, "--inactive")).err).toEqual([
      `✔ Updated ${created}: active → inactive.`,
    ]);
    expect((await run(...SET, ...FN_DAY_DISABLE, "--inactive", "--limit", "2000000")).err).toEqual([
      `✔ No changes to ${created} (2,000,000, inactive).`,
    ]);
    // Neither --active nor --inactive: the limit keeps its state.
    expect((await run(...SET, ...FN_DAY_DISABLE, "--limit", "2500000")).err).toEqual([
      `✔ Updated ${created}: limit 2,000,000 → 2,500,000.`,
    ]);
    expect((await run(...SET, ...FN_DAY_DISABLE, "--active", "--limit", "3")).err).toEqual([
      `✔ Updated ${created}: limit 2,500,000 → 3, inactive → active.`,
    ]);
    // --inactive on a new limit creates it unenforced.
    expect(
      (
        await run(
          ...SET,
          "--metric",
          "databaseIoGb",
          "--window",
          "month",
          "--type",
          "warning",
          "--limit",
          "5",
          "--inactive",
        )
      ).err,
    ).toEqual(["✔ Created warning usage limit on Database I/O per month: 5, inactive."]);
    const json = await run("usage-limits", "list", "--json");
    expect(JSON.parse(json.out.join("\n"))).toEqual([
      expect.objectContaining({
        metric: "functionCalls",
        window: "day",
        limitType: "disable",
        limit: 3,
        enabled: true,
      }),
      expect.objectContaining({
        metric: "databaseIoGb",
        window: "month",
        limitType: "warning",
        limit: 5,
        enabled: false,
      }),
    ]);
  });

  test("list: Convex's box-drawn table, sorted as Convex's, with the current usage and triggered", async () => {
    const { s, run } = await deployment();
    s.usageMeter.record("functionCalls", 1500);
    s.usageMeter.record("dataEgressGb", 3 * 2 ** 30);
    const set = (...args: string[]) => run(...SET, ...args);
    await set(...FN_DAY_DISABLE, "--limit", "2000000", "--inactive");
    await set("--metric", "functionCalls", "--window", "month", "--type", "warning", "--limit", "1500");
    await set("--metric", "functionCalls", "--window", "month", "--type", "disable", "--limit", "1000000");
    await set("--metric", "dataEgressGb", "--window", "day", "--type", "warning", "--limit", "4");
    await set("--metric", "actionComputeIsolateGbHours", "--window", "day", "--type", "warning", "--limit", "1");
    await set("--metric", "aiGatewayCostDollars", "--window", "month", "--type", "disable", "--limit", "25");
    const r = await run("usage-limits", "list");
    expect(r.code).toBe(0);
    expect(r.err).toEqual([PENDING]);
    expect(r.out.join("\n")).toBe(
      [
        "┌────────────────┬────────┬─────────┬────────────┬───────────────────┬────────┬───────────┐",
        "│ Metric         │ Window │ Type    │      Limit │     Current Usage │ Active │ Triggered │",
        "├────────────────┼────────┼─────────┼────────────┼───────────────────┼────────┼───────────┤",
        "│ Function calls │ month  │ warning │ 1.5K calls │ 1.5K calls (100%) │ yes    │ yes       │",
        "│ Function calls │ month  │ disable │   1M calls │   1.5K calls (0%) │ yes    │ no        │",
        "│ Function calls │ day    │ disable │   2M calls │   1.5K calls (0%) │ no     │ no        │",
        "│ Action compute │ day    │ warning │ 1 GB-hours │   0 GB-hours (0%) │ yes    │ no        │",
        "│ Data egress    │ day    │ warning │       4 GB │        3 GB (75%) │ yes    │ no        │",
        "│ AI Gateway     │ month  │ disable │ 25 dollars │    0 dollars (0%) │ yes    │ no        │",
        "└────────────────┴────────┴─────────┴────────────┴───────────────────┴────────┴───────────┘",
      ].join("\n"),
    );
    const json = JSON.parse((await run("usage-limits", "list", "--json")).out.join("\n"));
    expect(json[0]).toEqual({
      id: expect.any(String),
      metric: "functionCalls",
      window: "month",
      limitType: "warning",
      limit: 1500,
      enabled: true,
      currentUsage: 1500,
      unit: "calls",
      triggered: true,
    });
  });

  test("remove (and its aliases): by (metric, window, type); a missing one is Convex's error", async () => {
    const { run } = await deployment();
    await run(...SET, ...FN_DAY_DISABLE, "--limit", "10");
    await run(...SET, "--metric", "searchQueryGb", "--window", "month", "--type", "warning", "--limit", "10");
    expect(await run("usage-limits", "remove", ...FN_DAY_DISABLE)).toEqual({
      code: 0,
      out: [],
      err: ["✔ Deleted disable usage limit on Function calls per day."],
    });
    expect(await run("usage-limits", "rm", ...FN_DAY_DISABLE)).toEqual({
      code: 1,
      out: [],
      err: ["✖ error: No disable usage limit on functionCalls per day."],
    });
    expect(
      (await run("usage-limits", "delete", "--metric", "searchQueryGb", "--window", "month", "--type", "warning")).err,
    ).toEqual(["✔ Deleted warning usage limit on Search queries per month."]);
    expect((await run("usage-limits", "list")).err).toEqual(["No usage limits configured."]);
  });

  test("Convex's argument errors, before the deployment is asked", async () => {
    const { run } = await deployment();
    const err = async (...args: string[]) => {
      const r = await run(...args);
      return [r.code, r.err[0]];
    };
    for (const bad of ["0", "-3", "1.5", "lots"])
      expect(await err(...SET, ...FN_DAY_DISABLE, "--limit", bad)).toEqual([
        1,
        `✖ error: --limit must be a positive integer, got "${bad}".`,
      ]);
    expect(await err(...SET, ...FN_DAY_DISABLE, "--active", "--inactive", "--limit", "1")).toEqual([
      1,
      "✖ error: Pass at most one of --active and --inactive.",
    ]);
    expect(await err(...SET, "--window", "day", "--type", "disable", "--limit", "1")).toEqual([
      1,
      "error: required option '--metric <metric>' not specified",
    ]);
    // DV-308: the isolate actions' metric is bunvex's name.
    expect(await err(...SET, "--metric", "actionComputeConvexGbHours", "--window", "day", "--type", "disable")).toEqual(
      [
        1,
        "error: option '--metric <metric>' argument 'actionComputeConvexGbHours' is invalid. Allowed choices are functionCalls, queryMutationComputeGbHours, actionComputeIsolateGbHours, actionComputeNodeJsGbHours, actionComputeCpuGbHours, databaseIoGb, searchQueryGb, dataEgressGb, aiGatewayCostDollars.",
      ],
    );
    expect(await err(...SET, ...FN_DAY_DISABLE.slice(0, 4), "--type", "stop")).toEqual([
      1,
      "error: option '--type <type>' argument 'stop' is invalid. Allowed choices are warning, disable.",
    ]);
    // Argument errors as Convex's commander prints them (STUDY-124): exit 1, no help after them.
    expect(await err("usage-limits", "remove", ...FN_DAY_DISABLE, "--limit", "1")).toEqual([
      1,
      "error: unknown option '--limit'",
    ]);
    expect(await err("usage-limits", "list", "--metric", "functionCalls")).toEqual([
      1,
      "error: unknown option '--metric'",
    ]);
    expect(await err("usage-limits", "lst")).toEqual([1, "error: unknown command 'lst'\n(Did you mean list?)"]);
    expect(await err("usage-limits", "set", ...FN_DAY_DISABLE, "--limit", "1", "extra")).toEqual([
      1,
      "error: too many arguments for 'set'. Expected 0 arguments but got 1.",
    ]);
    expect(await err("usage", "extra")).toEqual([
      1,
      "error: too many arguments for 'usage'. Expected 0 arguments but got 1.",
    ]);
    expect(await err("usage", "--jsn")).toEqual([1, "error: unknown option '--jsn'\n(Did you mean --json?)"]);
    expect(await err("--json")).toEqual([1, "error: unknown option '--json'"]);
    expect(await err("create")).toEqual([1, "error: unknown command 'create'"]);
    expect((await run("usage-limits", "list")).err).toEqual(["No usage limits configured."]);
  });

  test("the server's errors, as Convex's fetch errors print them", async () => {
    const { s, run } = await deployment();
    s.usageMeter.record("functionCalls", 50);
    const below = await run(...SET, ...FN_DAY_DISABLE, "--limit", "10");
    expect(below.code).toBe(1);
    expect(below.err).toEqual([
      "✖ 400 Bad Request: UsageLimitBelowCurrentUsage: Usage limit of 10 is below the current day usage of 50 for functionCalls. Set the limit at or above the current usage.",
    ]);
    // A 403: the server's message alone.
    const denied = await run(...SET, ...FN_DAY_DISABLE, "--limit", "100", "--read-only");
    expect(denied.code).toBe(1);
    expect(denied.err).toHaveLength(1);
    expect(denied.err[0]).toStartWith("✖ ");
    expect(denied.err[0]).not.toContain("403");
  });
});

describe("bunvex deployment usage", () => {
  test("a table of every metric's day and month, Convex's order and formats; --json is the server's answer", async () => {
    const { s, url, run } = await deployment();
    s.usageMeter.record("functionCalls", 1);
    s.usageMeter.record("databaseIoGb", 1234567 * 2 ** 30);
    const r = await run("usage");
    expect(r.code).toBe(0);
    expect(r.err).toEqual([PENDING]);
    expect(r.out.join("\n")).toBe(
      [
        "┌──────────────────────────┬────────────┬────────────┐",
        "│ Metric                   │ Day        │ Month      │",
        "├──────────────────────────┼────────────┼────────────┤",
        "│ Function calls           │ 1 call     │ 1 call     │",
        "│ Query/Mutation compute   │ 0 GB-hours │ 0 GB-hours │",
        "│ Action compute           │ 0 GB-hours │ 0 GB-hours │",
        "│ Action compute (Node.js) │ 0 GB-hours │ 0 GB-hours │",
        "│ Action compute (CPU)     │ 0 GB-hours │ 0 GB-hours │",
        "│ Database I/O             │ 1.235M GB  │ 1.235M GB  │",
        "│ Search queries           │ 0 Query-GB │ 0 Query-GB │",
        "│ Data egress              │ 0 GB       │ 0 GB       │",
        "│ AI Gateway               │ 0 dollars  │ 0 dollars  │",
        "└──────────────────────────┴────────────┴────────────┘",
      ].join("\n"),
    );
    const json = await run("usage", "--json");
    const direct = await (
      await fetch(`${url}/api/v1/get_current_usage`, { headers: { authorization: `Bunvex ${KEY}` } })
    ).json();
    expect(JSON.parse(json.out.join("\n"))).toEqual(direct);
    expect(json.out.join("\n")).toBe(JSON.stringify(direct, null, 2));
    expect(json.err).toEqual([]);
  });

  test("formatTable: Convex's box drawing, padding and right alignment", () => {
    expect(
      formatTable(
        ["A", "Bee"],
        [
          ["x", "1"],
          ["long", "22"],
        ],
        [1],
      ),
    ).toBe(
      ["┌──────┬─────┐", "│ A    │ Bee │", "├──────┼─────┤", "│ x    │   1 │", "│ long │  22 │", "└──────┴─────┘"].join(
        "\n",
      ),
    );
  });
});

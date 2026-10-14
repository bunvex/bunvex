// STUDY-149 PR 4's mappings without a server: the module list and the validators as the contract lists them, a
// run's result and log lines, the custom test query's request and answers, and the Settings documents (exports,
// imports, auth providers). The shapes are the ones Convex's backend sends (checked against its binary in
// packages/differential/test/dashboard-functions.test.ts).
import { describe, expect, test } from "bun:test";
import type { Capabilities } from "@bunvex/dashboard/data-source";
import { AdminHttp } from "../src/admin-http.ts";
import { Functions, functionsOf, runLogLine, runOf, TEST_QUERY_PREAMBLE } from "../src/functions.ts";
import { authProviderOf, exportOf, importOf } from "../src/settings.ts";
import type { AdminSync } from "../src/sync.ts";

const module = (functions: { name: string; lineno?: number; udfType: string; kind?: string }[]) => ({
  functions: functions.map((f) => ({
    name: f.name,
    udfType: f.udfType,
    visibility: { kind: f.kind ?? "public" },
    ...(f.lineno !== undefined && { lineno: f.lineno }),
  })),
  sourcePackageId: "pkg",
});

describe("the function list", () => {
  test("queries, mutations and actions at module:name, with their line; HTTP routes by their route, under their module; child components left out", () => {
    const fns = functionsOf(
      [
        [
          null,
          [
            [
              "messages.js",
              module([
                { name: "list", lineno: 4, udfType: "Query" },
                { name: "send", udfType: "Mutation", kind: "internal" },
              ]),
            ],
            ["dir/nested.js", module([{ name: "default", lineno: 2, udfType: "Action" }])],
            ["http.js", module([{ name: "GET /hello", lineno: 5, udfType: "HttpAction" }])],
          ],
        ],
        ["child", [["other.js", module([{ name: "x", udfType: "Query" }])]]],
      ],
      [],
    );
    expect(fns).toEqual([
      { path: "messages:list", kind: "query", visibility: "public", line: 4 },
      { path: "messages:send", kind: "mutation", visibility: "internal" },
      { path: "dir/nested:default", kind: "action", visibility: "public", line: 2 },
      // Convex's identifier for a route, as the logs and the metrics name it (`processAnalyzedModuleFunction`)
      { path: "GET /hello", kind: "httpAction", module: "http", visibility: "public", line: 5 },
    ]);
  });

  test("validators from the API spec, in the contract's JSON; v.any() is none", () => {
    const [fn] = functionsOf(
      [[null, [["m.js", module([{ name: "f", udfType: "Query" }])]]]],
      [
        {
          identifier: "m.js:f",
          functionType: "Query",
          args: { type: "object", value: { n: { fieldType: { type: "literal", value: 3n }, optional: false } } },
          returns: { type: "any" },
        },
      ],
    );
    expect(fn!.args).toEqual({
      type: "object",
      value: { n: { fieldType: { type: "literal", value: { $integer: "AwAAAAAAAAA=" } }, optional: false } },
    });
    expect(fn!.returns).toBeUndefined();
  });
});

describe("a run", () => {
  test("its log lines: the level from the tag, the rest as it is (Convex's entryLogLines)", () => {
    expect(runLogLine("[LOG] 'a' 1")).toEqual({ level: "info", message: "'a' 1" });
    expect(runLogLine("[WARN] careful")).toEqual({ level: "warn", message: "careful" });
    expect(runLogLine("[ERROR] x\ny")).toEqual({ level: "error", message: "x\ny" });
    expect(runLogLine("no tag")).toEqual({ level: "info", message: "no tag" });
  });

  test("a value in the contract's encoding, undefined as null; an error with its data", () => {
    expect(runOf({ success: true, value: { n: 1n }, logLines: ["[INFO] hi"] }, 3)).toEqual({
      value: { n: { $integer: "AQAAAAAAAAA=" } },
      logLines: [{ level: "info", message: "hi" }],
      durationMs: 3,
    });
    // a function that returns nothing
    expect(runOf({ success: true, value: undefined as never, logLines: [] }, 0).value).toBeNull();
    expect(
      runOf({ success: false, errorMessage: "Uncaught BunvexError: no", errorData: { code: 2n }, logLines: [] }, 1),
    ).toEqual({
      error: { message: "Uncaught BunvexError: no", data: { code: { $integer: "AgAAAAAAAAA=" } } },
      logLines: [],
      durationMs: 1,
    });
  });
});

describe("the custom test query (/api/run_test_function)", () => {
  const all: Capabilities = { operations: ["runFunctions"], readOnly: true };
  const with_ = (status: number, body: unknown, caps = all) => {
    const sent: { url: string; init: RequestInit }[] = [];
    const http = new AdminHttp({
      url: "http://deployment/",
      adminKey: "key",
      fetch: async (url, init) => {
        sent.push({ url, init: init! });
        return new Response(JSON.stringify(body), { status });
      },
    });
    const fns = new Functions({} as AdminSync, http, { url: "http://deployment/", adminKey: "key" }, async () => caps);
    return { fns, sent };
  };

  test("as Convex's dashboard sends it: the key in the body, no Authorization header, the builders imported", async () => {
    const { fns, sent } = with_(200, { status: "success", value: { $integer: "AQAAAAAAAAA=" }, logLines: ["[LOG] x"] });
    const r = await fns.runTestQuery("export default query(async () => 1n);");
    expect(r).toMatchObject({ value: { $integer: "AQAAAAAAAAA=" }, logLines: [{ level: "info", message: "x" }] });
    expect(sent[0]!.url).toBe("http://deployment/api/run_test_function");
    expect(new Headers(sent[0]!.init.headers).get("authorization")).toBeNull();
    expect(JSON.parse(sent[0]!.init.body as string)).toEqual({
      bundle: { path: "testQuery.js", source: `${TEST_QUERY_PREAMBLE}export default query(async () => 1n);` },
      adminKey: "key",
      args: {},
      format: "encoded_json",
    });
  });

  test("a thrown error is the run's; a 4xx is the run's error with its message; a refused key and a 5xx reject", async () => {
    const thrown = await with_(200, {
      status: "error",
      errorMessage: "Uncaught Error: no",
      errorData: { a: 1 },
      logLines: [],
    }).fns.runTestQuery("x");
    expect(thrown).toMatchObject({ error: { message: "Uncaught Error: no", data: { a: 1 } } });
    expect(
      (await with_(400, { code: "InvalidModules", message: "does not load" }).fns.runTestQuery("x")).error,
    ).toEqual({ message: "does not load" });
    const refused = await with_(401, { message: "bad key" })
      .fns.runTestQuery("x")
      .catch((e: { code: string }) => e.code);
    expect(refused).toBe("unauthorized");
    const failed = await with_(500, {})
      .fns.runTestQuery("x")
      .catch((e: { code: string }) => e.code);
    expect(failed).toBe("unavailable");
    const forbidden = await with_(200, {}, { operations: [], readOnly: false })
      .fns.runTestQuery("x")
      .catch((e: { code: string }) => e.code);
    expect(forbidden).toBe("unauthorized");
  });
});

describe("Settings' documents", () => {
  const NS = 1_000_000n;
  test("an export: times in ms, its state as stored (canceled too), with or without the files", () => {
    expect(
      exportOf({
        _id: "e",
        _creationTime: 5,
        state: "completed",
        format: { format: "zip", include_storage: true },
        start_ts: 10n * NS,
        complete_ts: 20n * NS,
        expiration_ts: 30n * NS,
        size: 99n,
      }),
    ).toEqual({
      id: "e",
      state: "completed",
      requestedAt: 10,
      includeStorage: true,
      completedAt: 20,
      size: 99,
      expiresAt: 30,
    });
    expect(
      exportOf({
        _id: "e",
        _creationTime: 5,
        state: "in_progress",
        format: { format: "zip" },
        progress_message: "Tables",
      }),
    ).toEqual({ id: "e", state: "in_progress", requestedAt: 5, includeStorage: false, progress: "Tables" });
    expect(exportOf({ _id: "e", _creationTime: 5, state: "canceled", format: { format: "zip" } }).state).toBe(
      "canceled",
    );
  });

  test("an import: each state; what changes, per table, from its checkpoints", () => {
    const base = {
      _id: "i",
      _creationTime: 1,
      format: { format: "jsonl", table: "t" },
      mode: "Replace",
      checkpoints: null,
    };
    expect(importOf({ ...base, state: { state: "uploaded" } })).toEqual({
      id: "i",
      state: "uploaded",
      format: "jsonLines",
      mode: "replace",
    });
    expect(
      importOf({
        ...base,
        state: { state: "waiting_for_confirmation", message_to_confirm: "…", require_manual_confirmation: true },
        checkpoints: [{ display_table_name: "t", total_num_rows_to_write: 2n, existing_rows_to_delete: 5n }],
      }).changes,
    ).toEqual([{ table: "t", add: 2, delete: 5 }]);
    expect(
      importOf({ ...base, state: { state: "in_progress", progress_message: "Importing", checkpoint_messages: ["a"] } }),
    ).toMatchObject({ progress: "Importing", checkpoints: ["a"] });
    expect(importOf({ ...base, state: { state: "completed", timestamp: 1n, num_rows_written: 7n } }).rowsWritten).toBe(
      7,
    );
    expect(importOf({ ...base, state: { state: "failed", error_message: "bad" } }).error).toBe("bad");
    expect(
      importOf({ ...base, format: { format: "zip" }, mode: "ReplaceAll", state: { state: "uploaded" } }),
    ).toMatchObject({ format: "zip", mode: "replaceAll" });
  });

  test("auth providers: OIDC, and a custom JWT with its stored algorithm unquoted and no null application id", () => {
    expect(authProviderOf({ _id: "a", _creationTime: 1, domain: "https://d", applicationID: "app" })).toEqual({
      domain: "https://d",
      applicationID: "app",
    });
    expect(
      authProviderOf({
        type: "customJwt",
        issuer: "https://i",
        jwks: "https://j",
        algorithm: '"ES256"',
        applicationID: null,
      }),
    ).toEqual({ type: "customJwt", issuer: "https://i", jwks: "https://j", algorithm: "ES256" });
  });
});

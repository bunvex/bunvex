// The Data screen's writes (STUDY-149 PR 3), where no live server is needed: what each contract write sends,
// the clear's loop on its cursor, a `success: false` answer, and how a failure's words become the contract's codes.
import { describe, expect, test } from "bun:test";
import type { DataSourceError } from "@bunvex/dashboard/data-source";
import type { AdminHttp } from "../src/admin-http.ts";
import type { AdminSync } from "../src/sync.ts";
import type { Tables } from "../src/tables.ts";
import { dataWrites, UNDEFINED_PLACEHOLDER, writeError } from "../src/writes.ts";

type Call = { path: string; args: Record<string, unknown> };

/** The writes over a fake connection: each mutation answers `answer(call)`. */
function fake(answer: (c: Call) => unknown, tableNames: string[] = ["t"]) {
  const calls: Call[] = [];
  const posts: { path: string; body: unknown }[] = [];
  const sync = {
    client: {
      mutationInternal: async (path: string, args: Record<string, unknown>) => {
        calls.push({ path, args });
        const r = answer({ path, args });
        return r instanceof Error
          ? { success: false, errorMessage: r.message, errorData: (r as Error & { data?: unknown }).data, logLines: [] }
          : { success: true, value: r ?? null, logLines: [] };
      },
    },
  } as unknown as AdminSync;
  const http = {
    request: async (path: string, req: { body?: unknown }) => {
      posts.push({ path, body: req.body });
      // the subscribed mapping hears the deletion a moment after the route answers
      const gone = (req.body as { tableNames: string[] }).tableNames;
      setTimeout(() => tableNames.splice(0, tableNames.length, ...tableNames.filter((n) => !gone.includes(n))), 30);
      return new Response(null);
    },
  } as unknown as AdminHttp;
  const tables = { tableNames: async () => [...tableNames] } as unknown as Tables;
  return { writes: dataWrites(sync, http, tables), calls, posts };
}
const ok = () => ({ success: true });

describe("what the writes send (Convex's dashboard calls)", () => {
  test("every mutation carries componentId null; values decoded; a removed field is the placeholder", async () => {
    const { writes, calls } = fake(ok);
    await writes.insertDocuments("t", [{ big: { $integer: "AQAAAAAAAAA=" }, raw: { $bytes: "AQID" } }]);
    await writes.patchDocuments("t", ["a", "b"], { gone: { $unset: true }, n: 2 });
    await writes.replaceDocument("t", "a", { x: 1 });
    await writes.deleteDocuments("t", ["a", "b"]);
    await writes.createTable("u");
    const raw = calls[0]!.args.documents as Record<string, unknown>[];
    expect(raw[0]!.big).toBe(1n);
    expect(new Uint8Array(raw[0]!.raw as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls.slice(1)).toEqual([
      {
        path: "_system/frontend/patchDocumentsFields",
        args: { table: "t", ids: ["a", "b"], fields: { gone: UNDEFINED_PLACEHOLDER, n: 2 }, componentId: null },
      },
      { path: "_system/frontend/replaceDocument", args: { id: "a", document: { x: 1 }, componentId: null } },
      {
        path: "_system/frontend/deleteDocuments",
        args: {
          toDelete: [
            { id: "a", tableName: "t" },
            { id: "b", tableName: "t" },
          ],
          componentId: null,
        },
      },
      { path: "_system/frontend/createTable", args: { table: "u", componentId: null } },
    ]);
    expect(calls[0]!.args.componentId).toBeNull();
    expect(UNDEFINED_PLACEHOLDER.startsWith("__BUNVEX_PLACEHOLDER_undefined_")).toBe(true);
  });

  test("patchAllDocuments is one patchDocumentsFields without ids (Convex's Edit all); its refusal's words", async () => {
    const tooMany = Object.assign(
      new Error("[Request ID: 1] Server Error\nUncaught BunvexError: Too many reads in a single function execution"),
      { data: "Too many reads in a single function execution (limit: 4096)." },
    );
    let answer: unknown = ok();
    const { writes, calls } = fake(() => answer);
    await writes.patchAllDocuments("t", { gone: { $unset: true }, big: { $integer: "AQAAAAAAAAA=" } });
    expect(calls).toEqual([
      {
        path: "_system/frontend/patchDocumentsFields",
        args: { table: "t", fields: { gone: UNDEFINED_PLACEHOLDER, big: 1n }, componentId: null },
      },
    ]);
    expect("ids" in calls[0]!.args).toBe(false);
    answer = tooMany;
    const e = (await writes.patchAllDocuments("t", { n: 1 }).catch((x) => x)) as DataSourceError;
    expect([e.code, e.message]).toEqual([
      "invalid_request",
      "Too many reads in a single function execution (limit: 4096).",
    ]);
    // an abort before the call sends nothing
    const ac = new AbortController();
    ac.abort(new Error("stopped"));
    expect(await writes.patchAllDocuments("t", { n: 1 }, { signal: ac.signal }).catch((x: Error) => x.message)).toBe(
      "stopped",
    );
    expect(calls.length).toBe(2);
  });

  test("clearTable calls clearTablePage on each page's cursor until hasMore is false, and sums deleted", async () => {
    const pages = [
      { deleted: 4000, continueCursor: "c1", hasMore: true },
      { deleted: 4000, continueCursor: "c2", hasMore: true },
      { deleted: 7, continueCursor: "c3", hasMore: false },
    ];
    const { writes, calls } = fake(() => pages.shift());
    expect(await writes.clearTable("t")).toEqual({ deleted: 8007 });
    expect(calls.map((c) => c.args.cursor)).toEqual([null, "c1", "c2"]);
    expect(calls.every((c) => c.path === "_system/frontend/clearTablePage" && c.args.tableName === "t")).toBe(true);
  });

  test("clearTable stops between pages on an abort, the table partly cleared; an unknown table is not_found", async () => {
    const ac = new AbortController();
    const { writes, calls } = fake(() => {
      ac.abort(new Error("stopped"));
      return { deleted: 4000, continueCursor: "c1", hasMore: true };
    });
    expect(await writes.clearTable("t", { signal: ac.signal }).catch((e: Error) => e.message)).toBe("stopped");
    expect(calls.length).toBe(1);
    const e = await writes.clearTable("nope").catch((x: DataSourceError) => x);
    expect([(e as DataSourceError).code, calls.length]).toEqual(["not_found", 1]);
  });

  test("a success: false answer is invalid_request with its error; createTable's null is fine", async () => {
    const { writes } = fake((c) =>
      c.path.endsWith("replaceDocument")
        ? { success: false, error: "Document does not exist." }
        : { success: false, error: "Can’t import more than 4096 documents at once." },
    );
    const e1 = (await writes.insertDocuments("t", [{}]).catch((x) => x)) as DataSourceError;
    expect([e1.code, e1.message]).toEqual(["invalid_request", "Can’t import more than 4096 documents at once."]);
    const e2 = (await writes.replaceDocument("t", "a", {}).catch((x) => x)) as DataSourceError;
    expect([e2.code, e2.message]).toEqual(["not_found", "Document does not exist."]);
  });

  test("deleteTables posts Convex's body, then waits for the subscribed mapping to drop the tables", async () => {
    const names = ["t", "u"];
    const { writes, posts } = fake(ok, names);
    await writes.deleteTables(["u"]);
    expect(posts).toEqual([{ path: "/api/delete_tables", body: { tableNames: ["u"], componentId: null } }]);
    expect(names).toEqual(["t"]);
  });
});

describe("writeError: a failure's words as the contract's codes", () => {
  const p = "_system/frontend/x";
  test("an application error's data is the message (Convex's dashboard shows error.data)", () => {
    const e = writeError(
      p,
      "[Request ID: 1] Server Error\nUncaught BunvexError: Failed to insert…\n",
      "Failed to insert…",
    );
    expect([e.code, e.message]).toEqual(["invalid_request", "Failed to insert…"]);
  });
  test("an uncaught error is a refusal with its line, frames dropped", () => {
    const e = writeError(
      p,
      "Server Error\nUncaught Error: Invalid argument `id` for `db.get`: Unable to decode ID\n    at foo (x.ts:1:1)\n",
    );
    expect([e.code, e.message]).toEqual(["invalid_request", "Invalid argument `id` for `db.get`: Unable to decode ID"]);
  });
  test("a document that is gone is not_found", () => {
    for (const [m, d] of [
      ["Server Error\nUncaught Error: Delete on nonexistent document ID abc\n", undefined],
      [
        "Server Error\nUncaught BunvexError: Cannot read properties of null (reading '_id')\n",
        "Cannot read properties of null (reading '_id')",
      ],
    ] as const)
      expect(writeError(p, m, d).code).toBe("not_found");
  });
  test("a permission refusal is unauthorized; a server failure unavailable", () => {
    expect(writeError(p, "Server Error\nYou don't have permission to perform this operation.\n").code).toBe(
      "unauthorized",
    );
    expect(writeError(p, "[Request ID: 1] Server Error").code).toBe("unavailable");
  });
});

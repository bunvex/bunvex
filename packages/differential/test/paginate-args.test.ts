// `paginate`'s options, cursors and query limits on Convex's backend (the oracle) and on bunvex's: what Convex's
// client checks (`query_impl.ts`), what its `queryPage` syscall reads (serde's messages, field by field) and checks (an empty
// page, too many items, zero limits), and its keybroker's messages for a cursor that does not parse. Each
// answer is a caught error's `<name>: <message>` or the page's size, compared as they are. Then the system
// functions' own argument checks (`Uncaught Error: <check>`), with an admin key. Local only: skipped, with a
// note, when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`paginate-args: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../paginate-app");
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
  for (const b of [convex, bunvex]) await b.call("mutation", "pages:add", { n: 3 });
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const value = (r: { body: unknown }) => (r.body as { value?: unknown }).value ?? r.body;

const OPTIONS: Record<string, unknown>[] = [
  ...([0, "$-0", 0.5, 2.5, 1e-7, 1e-6, 32000.5, "$NaN", "$Infinity", "$-Infinity", 1e20, 1e21] as unknown[])
    .concat([2 ** 63, 2 ** 64, 1e300, 3, 32000, 32001, -1, -0.5, "x", true, null])
    .map((numItems) => ({ numItems, cursor: null })),
  ...[
    0,
    "$-0",
    0.5,
    -1,
    1e21,
    2.5,
    null,
    "x",
    true,
    {},
    [1],
    "$NaN",
    "$Infinity",
    -(2 ** 63),
    1.5e-5,
    "$bigint",
  ].flatMap((m) => [
    { numItems: 1, cursor: null, maximumRowsRead: m },
    { numItems: 1, cursor: null, maximumBytesRead: m },
  ]),
  ...["", "zz", "00", "07", "07aa", 5, -3, 1.5, true, {}, [], 2 ** 64, "$bigint"].flatMap((c) => [
    { numItems: 1, cursor: c },
    { numItems: 1, cursor: null, endCursor: c },
  ]),
  { numItems: 1 },
  { numItems: 1, endCursor: "$undefined" },
  { numItems: 0.5, cursor: 5 },
  { numItems: 0.5, cursor: null, endCursor: 5 },
  { numItems: 2.5, cursor: null, maximumRowsRead: 0.5 },
  { maximumBytesRead: "b", maximumRowsRead: "r", numItems: 1, cursor: null },
  { numItems: 0, cursor: null, maximumRowsRead: 0.5 },
  { numItems: 1, cursor: null, maximumRowsRead: 0.5, maximumBytesRead: 0 },
  { numItems: 40000, cursor: null, maximumRowsRead: 0.5 },
  { numItems: 0, cursor: "zz" },
  { numItems: 1, cursor: "zz", maximumRowsRead: 0 },
  { numItems: 40000, cursor: "zz" },
];

describe.skipIf(!ready)("paginate's options and cursors", () => {
  test("every option set: the same outcome", async () => {
    const differences: unknown[] = [];
    for (const opts of OPTIONS) {
      const [c, b] = await Promise.all([convex, bunvex].map((x) => x.call("query", "pages:page", { opts })));
      if (JSON.stringify(value(c!)) !== JSON.stringify(value(b!)))
        differences.push({ opts, convex: value(c!), bunvex: value(b!) });
    }
    for (const raw of ["undefined", "null"]) {
      const [c, b] = await Promise.all([convex, bunvex].map((x) => x.call("query", "pages:page", { opts: {}, raw })));
      if (JSON.stringify(value(c!)) !== JSON.stringify(value(b!)))
        differences.push({ raw, convex: value(c!), bunvex: value(b!) });
    }
    expect(differences).toEqual([]);
  }, 120_000);

  test("a limit that is not a usize: serde_json's wording, floats included", async () => {
    const differences: unknown[] = [];
    for (const n of [0.5, 1e-7, 1e-6, 1.5e-5, 1e20, 1e21, 2 ** 64, -(2 ** 63), -1, "$NaN", "x", 2 ** 60])
      for (const page of [false, true]) {
        const [c, b] = await Promise.all([convex, bunvex].map((x) => x.call("query", "pages:limited", { n, page })));
        if (JSON.stringify(value(c!)) !== JSON.stringify(value(b!)))
          differences.push({ n, page, convex: value(c!), bunvex: value(b!) });
      }
    expect(differences).toEqual([]);
  });

  test("a sealed cursor that does not open: the keybroker's message, without its code", async () => {
    const answers = await Promise.all(
      [convex, bunvex].map(async (b) =>
        value(await b.call("query", "pages:tamperedCursor", { cursor: `07${"ab".repeat(40)}` })),
      ),
    );
    expect(answers).toEqual(["Error: Failed to parse cursor", "Error: Failed to parse cursor"]);
  });
});

describe.skipIf(!ready)("system functions check their own arguments", () => {
  const sys = async (b: Backend, path: string, args: unknown) => {
    const r = await fetch(`${b.url}/api/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`,
      },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const body = (await r.json()) as { errorMessage?: string };
    return { status: r.status, error: body.errorMessage?.replace(/^\[Request ID: [0-9a-f]+\] /, "") };
  };
  const CALLS: [string, unknown][] = [
    ["_system/frontend/fileStorageV2:fileMetadata", {}],
    ["_system/frontend/fileStorageV2:fileMetadata", [1]],
    [
      "_system/frontend/fileStorageV2:fileMetadata",
      { paginationOpts: { numItems: 1, cursor: null }, filters: { order: "up" } },
    ],
    ["_system/frontend/paginatedScheduledJobs", {}],
    ["_system/frontend/listCronJobs", { extra: 1 }],
  ];
  for (const [path, args] of CALLS)
    test(`${path} ${JSON.stringify(args)}`, async () => {
      const [c, b] = await Promise.all([convex, bunvex].map((x) => sys(x, path, args)));
      expect(c!.error).toStartWith("Server Error\nUncaught Error: ");
      expect(b).toEqual(c!);
    });
});

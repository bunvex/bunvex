// A storage id's errors on Convex's backend (the oracle) and on bunvex's: every storage method (`getUrl`,
// `getMetadata`, `delete`, an action's `get`) in a query, a mutation and an action, given another table's id,
// ids that do not parse, and UUIDs. Another table's id is refused by Convex's model unwrapped; one that does not
// parse is wrapped by the syscall (crates/model/src/file_storage/mod.rs). Each answer is a caught error's
// `<name>: <message>` or `null` / `value`, compared as they are. Local only: skipped, with a note, when
// Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`storage-ids: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../storage-app");
let convex: Backend;
let bunvex: Backend;
const otherId: Record<string, string> = {};

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
  for (const b of [convex, bunvex])
    otherId[b.name] = ((await b.call("mutation", "files:insert", {})).body as { value: string }).value;
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const CALLS: ["query" | "mutation" | "action", string, string][] = [
  ["query", "files:inQuery", "getUrl"],
  ["query", "files:inQuery", "getMetadata"],
  ["mutation", "files:inMutation", "getUrl"],
  ["mutation", "files:inMutation", "getMetadata"],
  ["mutation", "files:inMutation", "delete"],
  ["action", "files:inAction", "getUrl"],
  ["action", "files:inAction", "getMetadata"],
  ["action", "files:inAction", "delete"],
  ["action", "files:inAction", "get"],
];

describe.skipIf(!ready)("a storage id's errors", () => {
  const uuid = crypto.randomUUID();
  const IDS: [string, (b: Backend) => string][] = [
    ["another table's id", (b) => otherId[b.name]!],
    ["another table's id, truncated", (b) => otherId[b.name]!.slice(0, -1)],
    ["garbage", () => "garbage"],
    ["empty", () => ""],
    ["quotes and a line break", () => 'a"b\n'],
    ["a UUID of no file", () => uuid],
    ["an upper-case UUID", () => uuid.toUpperCase()],
    ["not quite a UUID", () => "00000000-0000-0000-0000-00000000000G"],
  ];
  for (const [label, id] of IDS)
    test(label, async () => {
      const differences: unknown[] = [];
      for (const [kind, path, op] of CALLS) {
        const [c, b] = await Promise.all(
          [convex, bunvex].map(async (x) => {
            const r = await x.call(kind, path, { id: id(x), op });
            const value = (r.body as { value?: unknown }).value ?? r.body;
            return JSON.stringify(value).replaceAll(id(x), "<id>");
          }),
        );
        if (c !== b) differences.push({ path, op, convex: c, bunvex: b });
      }
      expect(differences).toEqual([]);
    });
});

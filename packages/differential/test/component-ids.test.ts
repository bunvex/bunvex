// Ids across a component boundary (STUDY-155 C4, STUDY-197): the same app (component-ids-app/) on Convex's backend
// and on bunvex's.
// - An app id given to a component's `v.id("messages")` is read by its table number in the component's tables. The
//   app's `items` is 10001, which is the component's `messages`, so it is accepted; the app's `messages` is 10002,
//   which is the component's `notes`, so it is refused.
// - A component's own id (`notes`) passes its `returns: v.id("notes")` and its `args: { id: v.id("notes") }`. Read in
//   the app's tables it would be the app's `messages`, and fail both.
// Local only: skipped, with a note, when Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`component-ids: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../component-ids-app");

/** The component's directory beside the app's files; for bunvex, its own config file names and imports. */
function prepare(project: string, dir: "convex" | "bunvex") {
  const fns = join(project, dir);
  cpSync(join(APP, "child"), join(fns, "child"), { recursive: true });
  if (dir === "convex") return;
  for (const d of [fns, join(fns, "child")]) {
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".ts")) continue;
      const path = join(d, name);
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .replaceAll('"convex/server"', '"bunvex/server"')
          .replaceAll('"convex/values"', '"bunvex/values"')
          .replaceAll("./child/convex.config", "./child/bunvex.config"),
      );
    }
    renameSync(join(d, "convex.config.ts"), join(d, "bunvex.config.ts"));
  }
}

let convex: Backend;
let bunvex: Backend;
beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP, prepare }), startBunvex({ app: APP, prepare })]);
}, 300_000);
afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const value = async (b: Backend, path: string, args: Record<string, unknown> = {}) => {
  const r = await b.call("mutation", path, args);
  if (!r.ok) throw new Error(`${b.name}: call failed: ${JSON.stringify(r.body)}`);
  // Ids are each backend's own: compared as a placeholder.
  return JSON.parse(
    JSON.stringify((r.body as { value: unknown }).value).replace(/ID \\"[0-9a-z]+\\"/g, 'ID \\"<id>\\"'),
  );
};

describe.skipIf(!ready)("ids across a component boundary", () => {
  test("an app id is read by its number in the component's tables (C4)", async () => {
    for (const table of ["items", "messages"]) {
      expect({ table, bunvex: await value(bunvex, "app:appIdToChild", { table }) }).toEqual({
        table,
        bunvex: await value(convex, "app:appIdToChild", { table }),
      });
    }
    expect(await value(convex, "app:appIdToChild", { table: "items" })).toEqual({ ok: "accepted" });
  });

  test("a component's own id passes its returns and args validators", async () => {
    const c = await value(convex, "app:childIdRoundTrip");
    expect(await value(bunvex, "app:childIdRoundTrip")).toEqual(c);
    expect(c).toEqual({ ok: "accepted" });
  });
});

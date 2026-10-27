// An auth config read as its JSON (STUDY-188 R4 follow-up): Convex's isolate takes the default export's
// `v8::json::stringify` (crates/isolate/src/environment/auth_config.rs:286). A function, a symbol, a `toJSON` that
// returns `undefined` give the text `undefined`, which serde refuses ("expected value"); `undefined` is a missing
// export; a function inside the config is left out. Each shape is pushed by each backend's CLI to the app of
// `auth-config-app/`, on Convex's backend and on bunvex's under both function sandboxes (`vm` and `process`), and
// the push's refusal compared after its prefix. Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`auth-config-json: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../auth-config-app");
type Deployed = { backend: Backend; functions: string };
let backends: Deployed[] = [];

beforeAll(async () => {
  if (!ready) return;
  const dirs: string[] = [];
  const at = (i: number) => (p: string, d: string) => {
    dirs[i] = join(p, d);
  };
  const started = await startAll([
    startConvex({ app: APP, prepare: at(0) }),
    startBunvex({ app: APP, prepare: at(1) }),
    startBunvex({
      app: APP,
      prepare: at(2),
      env: { BUNVEX_FUNCTION_SANDBOX: "process", BUNVEX_FUNCTION_SANDBOX_ISOLATION: "none" },
    }),
  ]);
  backends = started.map((backend, i) => ({ backend, functions: dirs[i]! }));
}, 300_000);

afterAll(async () => {
  await Promise.all(backends.map((b) => b.backend.stop()));
});

const PREFIX = "The pushed auth config is invalid: ";

/** A push of `source` as the auth config: "deployed", or its refusal after the prefix. */
async function push({ backend, functions }: Deployed, source: string | null) {
  const file = join(functions, "auth.config.ts");
  if (source === null) rmSync(file, { force: true });
  else writeFileSync(file, source);
  const r = await backend.cliOutput(["deploy", "--yes", "--typecheck=disable"], {});
  if (r.code === 0) return "deployed";
  const text = `${r.out}\n${r.err}`;
  const at = text.indexOf(PREFIX);
  if (at === -1) throw new Error(`${backend.name}: no refusal of the auth config in:\n${text}`);
  return errorText(text.slice(at + PREFIX.length).split("\n")[0]!);
}

const SHAPES = [
  "export default () => 1;",
  "export default function config() { return {}; }",
  "export default undefined;",
  "export default null;",
  'export default Symbol("s");',
  "export default { toJSON() { return undefined; } };",
  'export default { providers: [{ domain: "https://example.com", applicationID: "x", f() {} }] };',
  "export default { providers: () => 1 };",
  'export default { providers: [{ domain: "https://example.com", applicationID: "x", n: 10n }] };',
];

describe.skipIf(!ready)("an auth config read as its JSON, against Convex's backend", () => {
  test("a default export with no JSON, a missing one, a function inside", async () => {
    for (const source of SHAPES) {
      const [convex, ...ours] = await Promise.all(backends.map((b) => push(b, source)));
      expect(convex).not.toContain("docs.convex.dev");
      for (const [i, answer] of ours.entries())
        expect({ source, sandbox: i === 0 ? "vm" : "process", answer }).toEqual({
          source,
          sandbox: i === 0 ? "vm" : "process",
          answer: convex!,
        });
    }
    // What Convex's binary answered, so a change on either side shows here too.
    const [convex] = await Promise.all(backends.map((b) => push(b, "export default () => 1;")));
    expect(convex).toBe("auth config file must include a list of provider credentials: expected value");
    await Promise.all(backends.map((b) => push(b, null)));
  }, 300_000);
});

// A push error located through the definition module's source map (STUDY-186 A18, Convex's `45ec26a`), on Convex's
// backend (the oracle) and on bunvex's: an import the app's definition may not make, with a source map whose token
// for the import's position names an original line and column. Convex's `nicely_show_line_number_on_error` prints
// `name:line:col: message`, then the original line with the position marked, when the column is within the line (by
// its UTF-8 length, Rust's `str::len`); past it, `name:line:col: message` at the generated position, nothing more.
// The module's name differs by decision (DV-494: `bunvex:/bunvex.config.js`), so it is cut before comparing. Local
// only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`source-map-context: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex(), startBunvex()]);
}, 180_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** One base64 VLQ number of a source map's `mappings`. */
function vlq(n: number): string {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

/** The generated module: an import the app's definition may not make, its specifier at line 0, column 14. */
const SOURCE = `import x from "./other.js";export default x;`;

/** A map whose one token, at the module's start, names (`line`, `col`) of `original`. */
const sourceMap = (original: string, line: number, col: number) =>
  JSON.stringify({
    version: 3,
    sources: ["../convex/convex.config.ts"],
    sourcesContent: [original],
    names: [],
    mappings: [0, 0, line, col].map(vlq).join(""),
  });

/** start_push's answer for the app's definition with `map`: its status, code and message, the module's name cut. */
async function answer(b: Backend, map: string) {
  const path = b.name === "convex" ? "convex.config.js" : "bunvex.config.js";
  const r = await fetch(`${b.url}/api/deploy2/start_push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminKey: b.adminKey,
      functions: "convex/",
      appDefinition: {
        definition: { path, source: SOURCE, sourceMap: map, environment: "isolate" },
        dependencies: [],
        schema: null,
        changedModules: [],
        unchangedModuleHashes: [],
        udfServerVersion: "1.48.0",
      },
      componentDefinitions: [],
      nodeDependencies: [],
    }),
  });
  const body = (await r.json()) as { code?: string; message?: string };
  return {
    status: r.status,
    code: body.code,
    message: body.message?.replace(/\b(convex|bunvex):\/\1\.config\.js/g, "M"),
  };
}

const CASES: [name: string, original: string, line: number, col: number][] = [
  ["within the line", "// app\nimport other from './other';\n", 1, 7],
  ["at the line's end", "// app\nshort\n", 1, 5],
  ["past the line's end", "// app\nshort\n", 1, 40],
  ["past its UTF-16 length, within its UTF-8 one", "éééééééééé\n", 0, 15],
  ["within a line with multi-byte characters", "const é = 1; import x from 'y';\n", 0, 13],
  ["on a line the source does not have", "one line\n", 5, 0],
];

describe.skipIf(!ready)("source-mapped push errors, against Convex's backend", () => {
  for (const [name, original, line, col] of CASES)
    test(name, async () => {
      const map = sourceMap(original, line, col);
      const [c, b] = [await answer(convex, map), await answer(bunvex, map)];
      expect(c.status).toBe(400);
      expect(b).toEqual(c);
    });
});

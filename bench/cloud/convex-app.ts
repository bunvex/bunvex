// bench/cloud: writes the benchmark app as a Convex project, from the same bench/functions.ts bunvex's bench server
// registers, so both deploy the same handlers. The file is copied with its imports rewritten to Convex's packages
// (Convex's untyped builders are `queryGeneric` and the like);
// bench.ts exports each function by name (Convex registers a module's exports) and schema.ts the schema.
// Pinned to the Convex npm version the differential tests use. Then `bun install` there, and Convex's CLI deploys it.
//   bun bench/cloud/convex-app.ts /root/convex-app
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { bench } from "../functions.ts";

const CONVEX_NPM = "1.48.0";
const dir = process.argv[2];
if (!dir) throw new Error("usage: bun bench/cloud/convex-app.ts <dir>");

// Convex's builders without a schema's types are the `…Generic` ones (what convex/_generated/server re-exports).
const GENERIC = new Set(["query", "mutation", "action", "internalQuery", "internalMutation", "internalAction"]);
const source = (await Bun.file(`${import.meta.dir}/../functions.ts`).text())
  .replace(/import \{([^}]*)\} from "bunvex\/server";/, (_, names: string) => {
    const mapped = names
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => (GENERIC.has(n) ? `${n}Generic as ${n}` : n));
    return `import { ${mapped.join(", ")} } from "convex/server";`;
  })
  .replaceAll('"@bunvex/values"', '"convex/values"');
if (/bunvex\//.test(source)) throw new Error("bench/functions.ts imports a bunvex package the rewrite does not map");

rmSync(`${dir}/convex`, { recursive: true, force: true });
mkdirSync(`${dir}/convex`, { recursive: true });
writeFileSync(
  `${dir}/package.json`,
  `${JSON.stringify({ name: "bench-app", private: true, type: "module", dependencies: { convex: CONVEX_NPM } })}\n`,
);
writeFileSync(`${dir}/convex/lib.ts`, source);
writeFileSync(
  `${dir}/convex/bench.ts`,
  `import { bench } from "./lib";\n${Object.keys(bench)
    .map((name) => `export const ${name} = bench.${name};`)
    .join("\n")}\n`,
);
writeFileSync(`${dir}/convex/schema.ts`, 'export { benchSchema as default } from "./lib";\n');
console.log(`${dir}: ${Object.keys(bench).length} functions, convex@${CONVEX_NPM}`);

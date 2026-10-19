import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * After `codegen --init` in an app on the workspace's packages, which export their TypeScript sources: those
 * import each other by `.ts` paths, so the app's tsconfig needs `allowImportingTsExtensions` here. The published
 * packages ship `.d.ts` files and need nothing added (sync-e2e/node/npm-packages.node.ts).
 */
export function allowTsImports(app: string): void {
  const path = join(app, "bunvex/tsconfig.json");
  const text = readFileSync(path, "utf8");
  if (!text.includes('"noEmit": true\n')) throw new Error(`unexpected ${path}:\n${text}`);
  writeFileSync(path, text.replace('"noEmit": true\n', '"noEmit": true,\n    "allowImportingTsExtensions": true\n'));
}

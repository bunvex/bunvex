// The harness against an example a developer has run with `bun run dev`: the leftover `.env.local` names that
// local deployment (BUNVEX_DEPLOYMENT), and the harness's deploy must still target its own backend.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deploy } from "../index.ts";

const TUTORIAL = resolve(import.meta.dir, "../../tutorial");
const ENV_LOCAL = join(TUTORIAL, ".env.local");
const before = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, "utf8") : null;
afterAll(() => {
  if (before === null) rmSync(ENV_LOCAL, { force: true });
  else writeFileSync(ENV_LOCAL, before);
});

test("an example's leftover .env.local does not redirect the harness's deploy", async () => {
  writeFileSync(ENV_LOCAL, "BUNVEX_DEPLOYMENT=local:local-tutorial\nVITE_BUNVEX_URL=http://127.0.0.1:1\n");
  const d = await deploy(TUTORIAL);
  try {
    expect(await d.cli("run", "messages:list")).toContain("[]");
  } finally {
    await d.stop();
  }
});

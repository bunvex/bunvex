// The pending changesets (`.changeset/*.md`) as `bunx changeset version` will read them at the next release. A
// changeset that names a package the config ignores, beside packages it does not, is refused there ("Mixed changesets
// that contain both ignored and not ignored packages are not allowed"): #940's did, and the release would have stopped.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", ".changeset");
const config = JSON.parse(readFileSync(join(DIR, "config.json"), "utf8")) as { ignore?: string[] };
const ignored = (name: string) =>
  (config.ignore ?? []).some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));

/** The packages a changeset's front matter names. */
function packagesOf(text: string): string[] {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return [];
  return [...m[1]!.matchAll(/^"([^"]+)":\s*(?:major|minor|patch)\s*$/gm)].map((x) => x[1]!);
}

test("no pending changeset names an ignored package", () => {
  const bad: string[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".md") && f !== "README.md"))
    for (const name of packagesOf(readFileSync(join(DIR, file), "utf8")))
      if (ignored(name)) bad.push(`${file}: ${name}`);
  expect(bad).toEqual([]);
});

test("the front matter is read as changesets writes it", () => {
  expect(packagesOf('---\n"@bunvex/core": patch\n"@bunvex/ui": minor\n---\n\nText.')).toEqual([
    "@bunvex/core",
    "@bunvex/ui",
  ]);
});

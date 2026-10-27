// scripts/docs.ts: the study index from each study's index line, the parity counts from the rows' status, and the
// generated parts a pull request may not change.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  changedRegions,
  countRows,
  generatedRegions,
  holdsGenerated,
  studyRows,
  withReadmeCounts,
  withSiteCounts,
  withStudyIndex,
  withSummary,
} from "./docs.ts";

test("the study index: each study's own line, in number order, the text around the table kept", () => {
  const rows = studyRows([
    { name: "STUDY-10-b.md", text: "# STUDY-10 — B\n<!-- index: B, with `|` in code \\| | draft -->\n" },
    { name: "STUDY-2-a.md", text: "# STUDY-2 — A\n<!-- index: A | implemented (#1) -->\n" },
  ]);
  expect(rows).toEqual([
    "| [STUDY-2](STUDY-2-a.md) | A | implemented (#1) |",
    "| [STUDY-10](STUDY-10-b.md) | B, with `|` in code \\| | draft |",
  ]);
  const readme = "intro\n\n| Study | Topic | Status |\n|---|---|---|\n| [STUDY-1](old.md) | old | x |\n\nafter\n";
  expect(withStudyIndex(readme, rows)).toBe(
    `intro\n\n| Study | Topic | Status |\n|---|---|---|\n${rows.join("\n")}\n\nafter\n`,
  );
  expect(() => studyRows([{ name: "STUDY-3-c.md", text: "# STUDY-3 — C\n\n- **Status:** draft" }])).toThrow(
    "the line under its title",
  );
});

test("the parity counts: the status column's first word, n/a apart, the summary table not counted", () => {
  const area = [
    "| Feature | Source | bunvex status | Notes |",
    "|---|---|---|---|",
    "| a | x | done (#1) | |",
    "| b \\| c | x | **Partial** (STUDY-1) | |",
    "| d | x | missing | |",
    "| e | x | n/a (cloud-only) | |",
    "",
    "| Limit | Convex | bunvex status | Notes |",
    "|---|---|---|---|",
    "| f | 1 | done | |",
    "",
    "### Summary counts",
    "",
    "| Status | Count |",
    "|---|---|",
    "| done | 9 |",
    "| partial | 9 |",
    "| missing | 9 |",
    "| n/a (cloud-only) | 9 |",
    "| **total** | **36** |",
  ].join("\n");
  const c = countRows(area);
  expect(c).toEqual({ done: 2, partial: 1, missing: 1, na: 1 });
  expect(withSummary(area, c).split("\n").slice(-5)).toEqual([
    "| done | 2 |",
    "| partial | 1 |",
    "| missing | 1 |",
    "| n/a (cloud-only) | 1 |",
    "| **total** | **5** |",
  ]);
  const readme =
    "| Area | File | Done | Partial | Missing |\n|---|---|--:|--:|--:|\n| API | [a.md](a.md) | 1 | 1 | 1 |";
  expect(withReadmeCounts(readme, new Map([["a.md", c]]))).toEndWith("| API | [a.md](a.md) | 2 | 1 | 1 |");
  const site =
    '    { name: "API", done: 1, partial: 1, missing: 1 },\n    { name: "B", done: 0, partial: 0, missing: 0 },';
  expect(withSiteCounts(site, [c, { done: 3, partial: 0, missing: 0, na: 0 }])).toBe(
    '    { name: "API", done: 2, partial: 1, missing: 1 },\n    { name: "B", done: 3, partial: 0, missing: 0 },',
  );
});

// What a pull request may not change: the generated parts, compared between its merge base and its head. The cases
// edit the repository's own files, as a pull request would.

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
/** `text` with the first number `re`'s second group matches raised by one. */
const bump = (text: string, re: RegExp) => text.replace(re, (_, a: string, n: string) => `${a}${Number(n) + 1}`);

test("the generated parts: the index rows, a Summary counts table, the README's summary rows, PARITY's lines", () => {
  const study = generatedRegions("docs/study/README.md", read("docs/study/README.md"));
  expect([...study.keys()]).toEqual(["the index table"]);
  expect(study.get("the index table")).toStartWith("| [STUDY-01](STUDY-01-document-ids.md) |");
  expect(study.get("the index table")).not.toContain("| Study | Topic | Status |");

  const platform = generatedRegions("docs/parity/platform.md", read("docs/parity/platform.md"));
  expect([...platform.keys()]).toEqual(["the Summary counts table"]);
  expect(platform.get("the Summary counts table")).toStartWith("| Status | Count |");
  expect(platform.get("the Summary counts table")).toMatch(/\| \*\*total\*\* \| \*\*\d+\*\* \|$/);

  const readme = generatedRegions("docs/parity/README.md", read("docs/parity/README.md"));
  expect([...readme.keys()]).toEqual([
    "the summary row of server-api.md",
    "the summary row of client-sync.md",
    "the summary row of platform.md",
  ]);
  const site = generatedRegions("apps/site/src/content.ts", read("apps/site/src/content.ts"));
  expect(site.size).toBe(3);
  for (const line of site.values())
    expect(line).toMatch(/^\{ name: "[^"]+", done: \d+, partial: \d+, missing: \d+ \}$/);

  expect(generatedRegions("docs/parity/divergences.md", "# D\n\n| a | b |\n|---|---|\n| 1 | 2 |").size).toBe(0);
  expect(holdsGenerated("docs/parity/platform.md")).toBe(true);
  expect(holdsGenerated("docs/study/STUDY-01-document-ids.md")).toBe(false);
  expect(holdsGenerated("packages/core/src/index.ts")).toBe(false);
});

test("a pull request that edits a count, PARITY or an index row changes a generated part", () => {
  const platform = read("docs/parity/platform.md");
  const counted = bump(platform, /^(\| done \| )(\d+)/m);
  expect(counted).not.toBe(platform);
  expect(changedRegions("docs/parity/platform.md", platform, counted)).toEqual(["the Summary counts table"]);

  const readme = read("docs/parity/README.md");
  const row = bump(readme, /^(\| [^|]+ \| \[platform\.md\]\(platform\.md\) \| )(\d+)/m);
  expect(changedRegions("docs/parity/README.md", readme, row)).toEqual(["the summary row of platform.md"]);

  const site = read("apps/site/src/content.ts");
  const parity = bump(site, /(\{ name: "Function and database API", done: )(\d+)/);
  expect(changedRegions("apps/site/src/content.ts", site, parity)).toEqual([
    `PARITY's "Function and database API" counts`,
  ]);

  const index = read("docs/study/README.md");
  const added = index.replace(/^(\| \[STUDY-01\].*)$/m, "$1\n| [STUDY-999](STUDY-999-x.md) | X | draft |");
  expect(changedRegions("docs/study/README.md", index, added)).toEqual(["the index table"]);
});

test("a pull request that adds a study, moves a row's status or edits prose leaves the generated parts alone", () => {
  // A new study with its index line does not touch docs/study/README.md: the index is stale until the bot's PR.
  const index = read("docs/study/README.md");
  expect(changedRegions("docs/study/README.md", index, index.replace("## Index", "## Index\n\nMore prose."))).toEqual(
    [],
  );

  // A parity row from partial to done: the counts are stale now, and that is the bot's.
  const platform = read("docs/parity/platform.md");
  const moved = platform.replace(/^(\|[^\n]*\| )\*{0,2}[Pp]artial\b/m, "$1done");
  expect(moved).not.toBe(platform);
  expect(changedRegions("docs/parity/platform.md", platform, moved)).toEqual([]);

  // The prose above a Summary counts table is not generated.
  const prose = platform.replace(/^Recounted on [^\n]*$/m, "Counted by the bot.");
  expect(prose).not.toBe(platform);
  expect(changedRegions("docs/parity/platform.md", platform, prose)).toEqual([]);

  // A new area: its README row is on one side only, and a new file has no base.
  const readme = read("docs/parity/README.md");
  const area = readme.replace(
    /^(\| [^|]+ \| \[platform\.md\]\(platform\.md\) \|.*)$/m,
    "$1\n| New | [new.md](new.md) | 1 | 0 | 0 |",
  );
  expect(area).not.toBe(readme);
  expect(changedRegions("docs/parity/README.md", readme, area)).toEqual([]);
  expect(
    changedRegions("docs/parity/new.md", undefined, "### Summary counts\n\n| Status | Count |\n|---|---|"),
  ).toEqual([]);
});

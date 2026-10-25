// scripts/docs.ts: the study index from each study's index line, and the parity counts from the rows' status.
import { expect, test } from "bun:test";
import { countRows, studyRows, withReadmeCounts, withSiteCounts, withStudyIndex, withSummary } from "./docs.ts";

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

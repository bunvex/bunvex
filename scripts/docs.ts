// The docs' generated parts, written from their sources by a bot after merges, so pull requests never edit them (two
// PRs editing the same index row or count is where most merge-queue conflicts came from). The bot is
// .github/workflows/docs-regenerate.yml: after each push to main it runs `bun run docs` and lands the result as its own
// pull request, from the branch `docs/regenerate`.
//
//   `bun run check:docs` (CI): every study's index line is well formed and the generator runs; and, on a pull request,
//     the generated parts are as they are on its merge base (only `docs/regenerate` may change them). Generated parts
//     behind their sources are fine: the bot catches up after the merge.
//   `bun run docs`: writes them (the bot; or a local preview, not committed).
//
//   1. docs/study/README.md's index table: one row per study, in number order, each row the study's own
//      `<!-- index: <topic> | <status> -->` line (the line under its title). A study's row changes in that study.
//   2. docs/parity/README.md's summary table, the "Summary counts" tables of the area files, and the site's copy of the
//      counts (apps/site/src/content.ts `PARITY`): each area's rows counted by the word their status starts with
//      (done, partial, missing; n/a is not counted), as docs/parity/README.md describes.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const STUDY = join(ROOT, "docs/study");
const PARITY = join(ROOT, "docs/parity");
const SITE = join(ROOT, "apps/site/src/content.ts");

type Change = { file: string; before: string; after: string };
/** Lines [start, end) of a file. */
type Span = { start: number; end: number };

// ---------------------------------------------------------------- the study index

const INDEX_LINE = /^<!-- index: (.*) -->$/;

/** Each study's index row, in number order (then file name, for two studies of one number). */
export function studyRows(files: { name: string; text: string }[]): string[] {
  const rows: { n: number; name: string; row: string }[] = [];
  for (const { name, text } of files) {
    const m = INDEX_LINE.exec(text.split("\n")[1] ?? "");
    if (!m) throw new Error(`${name}: the line under its title must be \`<!-- index: <topic> | <status> -->\``);
    const n = Number(/^STUDY-(\d+)-/.exec(name)![1]);
    rows.push({ n, name, row: `| [STUDY-${name.slice(6, name.indexOf("-", 6))}](${name}) | ${m[1]} |` });
  }
  return rows.sort((a, b) => a.n - b.n || (a.name < b.name ? -1 : 1)).map((r) => r.row);
}

/** Where the index table's rows are. */
function indexTable(lines: string[]): Span | undefined {
  const head = lines.findIndex((l) => l.startsWith("| Study | Topic | Status |"));
  if (head < 0 || !/^\|[-|: ]+\|$/.test(lines[head + 1] ?? "")) return undefined;
  let end = head + 2;
  while (end < lines.length && lines[end]!.startsWith("|")) end++;
  return { start: head + 2, end };
}

/** `readme` with its index table's rows replaced by `rows`. */
export function withStudyIndex(readme: string, rows: string[]): string {
  const lines = readme.split("\n");
  const at = indexTable(lines);
  if (!at) throw new Error("docs/study/README.md: no index table");
  return [...lines.slice(0, at.start), ...rows, ...lines.slice(at.end)].join("\n");
}

function studyIndex(): Change {
  const names = readdirSync(STUDY).filter((f) => /^STUDY-\d+-.*\.md$/.test(f));
  const files = names.map((name) => ({ name, text: readFileSync(join(STUDY, name), "utf8") }));
  const file = join(STUDY, "README.md");
  const before = readFileSync(file, "utf8");
  return { file, before, after: withStudyIndex(before, studyRows(files)) };
}

// ---------------------------------------------------------------- the parity counts

export type Counts = { done: number; partial: number; missing: number; na: number };

/** A table row's cells; `\|` is a pipe inside a cell. */
const cells = (line: string) =>
  line
    .trim()
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim());
const SEPARATOR = /^\|[\s:|-]+\|$/;
/** A summary row of docs/parity/README.md: its area and its file, then the counts. */
const README_ROW = /^\| [^|]+ \| \[([a-z-]+\.md)\]\(\1\) \| \d+ \| \d+ \| \d+ \|$/;
/** An area of the site's `PARITY`: its name, then the counts. */
const SITE_AREA = /^\s*\{ name: "([^"]+)", done: \d+, partial: \d+, missing: \d+ \},?$/;

/** An area file's rows by status: every table with a status column, the "Summary counts" table left out. */
export function countRows(text: string): Counts {
  const counts: Counts = { done: 0, partial: 0, missing: 0, na: 0 };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith("|") || !SEPARATOR.test(lines[i + 1] ?? "")) continue;
    const header = cells(lines[i]!).map((h) => h.toLowerCase());
    // The summary table's first column is the status itself.
    const at = header[0] === "status" ? -1 : header.findIndex((h) => h.includes("status"));
    for (i += 2; i < lines.length && lines[i]!.startsWith("|"); i++) {
      if (at < 0) continue;
      const word = (cells(lines[i]!)[at] ?? "").replace(/^[*_ ]+/, "").toLowerCase();
      if (word.startsWith("done")) counts.done++;
      else if (word.startsWith("partial")) counts.partial++;
      else if (word.startsWith("missing")) counts.missing++;
      else if (word.startsWith("n/a")) counts.na++;
    }
  }
  return counts;
}

/** Where an area file's "Summary counts" table is (the first table after that heading): its header to its last row. */
function summaryTable(lines: string[]): Span | undefined {
  const at = lines.findIndex((l) => /^#+ Summary counts$/.test(l));
  if (at < 0) return undefined;
  let start = at + 1;
  while (start < lines.length && !lines[start]!.startsWith("| Status |")) start++;
  if (start === lines.length) return undefined;
  let end = start + 2;
  while (end < lines.length && lines[end]!.startsWith("|")) end++;
  return { start, end };
}

/** `text`'s "Summary counts" table with `c`'s numbers. */
export function withSummary(text: string, c: Counts): string {
  const lines = text.split("\n");
  const at = summaryTable(lines);
  if (!at) return text;
  for (let i = at.start + 2; i < at.end; i++) {
    const [label = ""] = cells(lines[i]!);
    const n = label.startsWith("done")
      ? c.done
      : label.startsWith("partial")
        ? c.partial
        : label.startsWith("missing")
          ? c.missing
          : label.startsWith("n/a")
            ? c.na
            : label === "**total**"
              ? null
              : undefined;
    if (n === undefined) continue;
    lines[i] =
      n === null
        ? `| **total** | **${c.done + c.partial + c.missing + c.na}** |`
        : lines[i]!.replace(/\| [^|]* \|$/, `| ${n} |`);
  }
  return lines.join("\n");
}

/** docs/parity/README.md's summary table with each area's counts (its rows name their file). */
export function withReadmeCounts(readme: string, byFile: Map<string, Counts>): string {
  return readme
    .split("\n")
    .map((l) => {
      const m = /^(\| [^|]+ \| \[([a-z-]+\.md)\]\(\2\) \|) \d+ \| \d+ \| \d+ \|$/.exec(l);
      const c = m && byFile.get(m[2]!);
      return c ? `${m[1]} ${c.done} | ${c.partial} | ${c.missing} |` : l;
    })
    .join("\n");
}

/** The site's `PARITY.areas`, in docs/parity/README.md's order, with `counts`. */
export function withSiteCounts(site: string, counts: Counts[]): string {
  let k = 0;
  return site.replace(
    /(\{ name: "[^"]+", )done: \d+, partial: \d+, missing: \d+( \})/g,
    (whole, a: string, b: string) => {
      const c = counts[k++];
      return c ? `${a}done: ${c.done}, partial: ${c.partial}, missing: ${c.missing}${b}` : whole;
    },
  );
}

function parityCounts(): Change[] {
  const readmeFile = join(PARITY, "README.md");
  const readme = readFileSync(readmeFile, "utf8");
  // The areas, in the summary table's order.
  const areas = readme
    .split("\n")
    .map((l) => README_ROW.exec(l)?.[1])
    .filter((a) => a !== undefined);
  if (areas.length === 0) throw new Error("docs/parity/README.md: no summary table");
  const byFile = new Map<string, Counts>();
  const changes: Change[] = [];
  for (const name of areas) {
    const file = join(PARITY, name);
    const before = readFileSync(file, "utf8");
    const counts = countRows(before);
    byFile.set(name, counts);
    changes.push({ file, before, after: withSummary(before, counts) });
  }
  changes.push({ file: readmeFile, before: readme, after: withReadmeCounts(readme, byFile) });
  const site = readFileSync(SITE, "utf8");
  changes.push({
    file: SITE,
    before: site,
    after: withSiteCounts(
      site,
      areas.map((a) => byFile.get(a)!),
    ),
  });
  return changes;
}

// ---------------------------------------------------------------- what a pull request leaves alone

/** The branch whose pull requests regenerate the generated parts (.github/workflows/docs-regenerate.yml). */
export const BOT_BRANCH = "docs/regenerate";

/** Whether `path` (from the repository's root) can hold generated parts. */
export const holdsGenerated = (path: string) =>
  path === "docs/study/README.md" || /^docs\/parity\/[^/]+\.md$/.test(path) || path === "apps/site/src/content.ts";

/**
 * The generated parts of `path`'s `text`, by name: the study index's rows (one part), an area file's "Summary counts"
 * table, each summary row of docs/parity/README.md (named by its file) and each area line of the site's `PARITY`
 * (named by its area). Empty for a file that holds none.
 */
export function generatedRegions(path: string, text: string): Map<string, string> {
  const lines = text.split("\n");
  const regions = new Map<string, string>();
  const span = (name: string, at: Span | undefined) => {
    if (at) regions.set(name, lines.slice(at.start, at.end).join("\n"));
  };
  if (path === "docs/study/README.md") span("the index table", indexTable(lines));
  else if (path === "docs/parity/README.md") {
    for (const l of lines) {
      const m = README_ROW.exec(l);
      if (m) regions.set(`the summary row of ${m[1]}`, l);
    }
  } else if (path.startsWith("docs/parity/")) span("the Summary counts table", summaryTable(lines));
  else if (path === "apps/site/src/content.ts") {
    for (const l of lines) {
      const m = SITE_AREA.exec(l);
      if (m) regions.set(`PARITY's "${m[1]}" counts`, l.trim().replace(/,$/, ""));
    }
  }
  return regions;
}

/**
 * The generated parts a change from `before` to `after` of `path` edits (`undefined`: the file does not exist). A part
 * on one side only is not an edit: a new area brings its summary row and its counts, which the bot then keeps.
 */
export function changedRegions(path: string, before: string | undefined, after: string | undefined): string[] {
  if (before === undefined || after === undefined) return [];
  const after_ = generatedRegions(path, after);
  return [...generatedRegions(path, before)]
    .filter(([name, text]) => after_.has(name) && after_.get(name) !== text)
    .map(([name]) => name);
}

const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout : undefined;
};

/**
 * The generated parts the working tree changes from its merge base with the base branch, as `<file>: <part>`
 * (`undefined`: no merge base). The base is DOCS_BASE (CI sets the pull request's base commit), else
 * `origin/$GITHUB_BASE_REF`, else `origin/main`. Uncommitted edits count too.
 */
function changedGenerated(): { base: string; changed: string[] } | undefined {
  const ref = process.env.DOCS_BASE || `origin/${process.env.GITHUB_BASE_REF || "main"}`;
  const base = git("merge-base", ref, "HEAD")?.trim();
  if (!base) return undefined;
  const files = (git("diff", "--name-only", base) ?? "").split("\n").filter(holdsGenerated);
  const changed: string[] = [];
  for (const file of files) {
    const before = git("show", `${base}:${file}`);
    const after = existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), "utf8") : undefined;
    for (const part of changedRegions(file, before, after)) changed.push(`${file}: ${part}`);
  }
  return { base, changed };
}

/** The branch checked: the pull request's head branch in CI, else the checked-out one. */
const branch = () => process.env.GITHUB_HEAD_REF || git("rev-parse", "--abbrev-ref", "HEAD")?.trim() || "";

// ---------------------------------------------------------------- run

if (import.meta.main) {
  const write = process.argv.includes("--write");
  // Computing them checks every study's index line and the parity tables' shape: a malformed one throws.
  const changes = [studyIndex(), ...parityCounts()].filter((c) => c.after !== c.before);
  if (write) {
    for (const c of changes) writeFileSync(c.file, c.after);
    for (const c of changes) console.log(`wrote ${c.file.slice(ROOT.length + 1)}`);
  } else {
    for (const c of changes)
      console.log(`${c.file.slice(ROOT.length + 1)}: behind its sources; the docs bot regenerates it after merges`);
    const event = process.env.GITHUB_EVENT_NAME;
    if (branch() === BOT_BRANCH) console.log(`✓ the study index lines are well formed (${BOT_BRANCH} regenerates)`);
    else if (event && event !== "pull_request") {
      // A merge group or a push to main: each pull request in it was checked against its own base.
      console.log(`✓ the study index lines are well formed (${event}: no pull request base to compare with)`);
    } else {
      const found = changedGenerated();
      if (!found) {
        console.error("No merge base to compare the generated docs with: fetch origin/main, or set DOCS_BASE.");
        process.exit(1);
      }
      if (found.changed.length) {
        for (const c of found.changed) console.error(`${c}: changed from the merge base (${found.base.slice(0, 12)})`);
        console.error(
          "These lines are generated (scripts/docs.ts), and a bot regenerates them after merges (the docs/regenerate\n" +
            "pull request). Revert them to the merge base's, and do not commit what `bun run docs` writes.",
        );
        process.exit(1);
      }
      console.log("✓ the study index lines are well formed, and the generated parts are left to the docs bot");
    }
  }
}

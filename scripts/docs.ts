// The docs' generated parts, kept in step with their sources so pull requests do not edit them by hand (two PRs
// editing the same index row or count is where most rebase conflicts came from). Run: `bun run check:docs` (CI runs
// it in `check`), and `bun run docs` to write them.
//
//   1. docs/study/README.md's index table: one row per study, in number order, each row the study's own
//      `<!-- index: <topic> | <status> -->` line (the line under its title). A study's row changes in that study.
//   2. docs/parity/README.md's summary table, the "Summary counts" tables of the area files, and the site's copy of the
//      counts (apps/site/src/content.ts `PARITY`): each area's rows counted by the word their status starts with
//      (done, partial, missing; n/a is not counted), as docs/parity/README.md describes.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const STUDY = join(ROOT, "docs/study");
const PARITY = join(ROOT, "docs/parity");
const SITE = join(ROOT, "apps/site/src/content.ts");

type Change = { file: string; before: string; after: string };

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

/** `readme` with its index table's rows replaced by `rows`. */
export function withStudyIndex(readme: string, rows: string[]): string {
  const lines = readme.split("\n");
  const head = lines.findIndex((l) => l.startsWith("| Study | Topic | Status |"));
  if (head < 0 || !/^\|[-|: ]+\|$/.test(lines[head + 1] ?? "")) throw new Error("docs/study/README.md: no index table");
  let end = head + 2;
  while (end < lines.length && lines[end]!.startsWith("|")) end++;
  return [...lines.slice(0, head + 2), ...rows, ...lines.slice(end)].join("\n");
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

/** `text`'s "Summary counts" table (the first table after that heading) with `c`'s numbers. */
export function withSummary(text: string, c: Counts): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^#+ Summary counts$/.test(l));
  if (at < 0) return text;
  let i = at + 1;
  while (i < lines.length && !lines[i]!.startsWith("| Status |")) i++;
  for (i += 2; i < lines.length && lines[i]!.startsWith("|"); i++) {
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
  const areas = [...readme.matchAll(/^\| [^|]+ \| \[([a-z-]+\.md)\]\(\1\) \| \d+ \| \d+ \| \d+ \|$/gm)].map(
    (m) => m[1]!,
  );
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

// ---------------------------------------------------------------- run

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const changes = [studyIndex(), ...parityCounts()].filter((c) => c.after !== c.before);
  if (write) {
    for (const c of changes) writeFileSync(c.file, c.after);
    for (const c of changes) console.log(`wrote ${c.file.slice(ROOT.length + 1)}`);
  } else if (changes.length) {
    for (const c of changes) console.error(`${c.file.slice(ROOT.length + 1)} is out of date`);
    console.error("Run `bun run docs` to write the generated docs (the study index and the parity counts).");
    process.exit(1);
  } else console.log("✓ the study index and the parity counts are up to date");
}

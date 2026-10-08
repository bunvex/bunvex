// The page's claims against their sources (SITE-01 §5): the benchmark is the report's, the code is the tutorial
// example's, the counts and the roadmap are docs/parity's, and every link to a repository path exists.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { leading, speedup } from "../src/components/benchmarks.tsx";
import {
  BENCH,
  CONFORMANCE,
  DRIVERS,
  FEATURES,
  FILES,
  INSTALL,
  MIGRATE,
  PARITY,
  parityPercent,
  SHIP,
  SITE,
  STATUS,
} from "../src/content.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

/** The header cells of the first markdown table after `heading`. */
function tableHeader(markdown: string, heading: string): string[] {
  const lines = markdown.slice(markdown.indexOf(heading)).split("\n");
  const line = lines.find((l) => l.startsWith("|"))!;
  return line
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim().replaceAll("**", ""));
}

/** The rows of the first markdown table after `heading`, as trimmed cells, header and divider dropped. */
function tableAfter(markdown: string, heading: string): string[][] {
  const lines = markdown.slice(markdown.indexOf(heading)).split("\n");
  const start = lines.findIndex((l) => l.startsWith("|"));
  const rows: string[][] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim().replaceAll("**", "")),
    );
  }
  return rows.slice(2);
}

describe("content", () => {
  test("the benchmark cells are the full report's, for Convex, bunvex on Postgres and bunvex on SQLite", () => {
    const report = read("docs/bench/E2E-VPS-2026-10-05.md");
    const clean = (cell: string) => cell.replace(/[¹²⚠]/g, "").trim();
    const column = (table: string[][], header: string[], name: string) => {
      const i = header.indexOf(name);
      expect(i).toBeGreaterThan(-1);
      return (scenario: string) => clean(table.find((r) => r[0] === scenario)![i]!);
    };
    const httpHeader = tableHeader(report, "## HTTP");
    const http = tableAfter(report, "## HTTP");
    const fanHeader = tableHeader(report, "## Fan-out");
    const fan = tableAfter(report, "## Fan-out");
    // our metric label → the report's scenario row
    const SCENARIO: Record<string, [string[][], string[], string]> = {
      "uncached indexed read, req/s": [http, httpHeader, "query, uncached"],
      "durable insert, req/s": [http, httpHeader, "insert, durable"],
      "action (query + mutation), req/s": [http, httpHeader, "action (query + mutation)"],
      "cached read, req/s": [http, httpHeader, "query, cached"],
      "10 000 subscribers, splay off, delivered · p99": [fan, fanHeader, "10 000"],
    };
    expect(BENCH.rows.map((r) => r.metric)).toEqual(Object.keys(SCENARIO));
    expect(BENCH.tabs.length as number).toBe(BENCH.rows.length);
    for (const row of BENCH.rows) {
      const [table, header, scenario] = SCENARIO[row.metric]!;
      const convex = header.includes("Convex") ? "Convex" : "Convex default";
      expect([row.convex, row.postgres, row.sqlite]).toEqual([
        column(table, header, convex)(scenario),
        column(table, header, "bunvex pg")(scenario),
        column(table, header, "bunvex sqlite")(scenario),
      ]);
    }
  });

  test("the speed-ups are computed from the cells, and a cell with no number has none", () => {
    expect(leading("1 337")).toBe(1337);
    expect(leading("100 % · 1.57 s")).toBe(100);
    expect(leading("OOM (6.7 GB)")).toBe(0);
    expect(BENCH.rows.map(speedup)).toEqual(["4.7×", "8.1×", "8.6×", "1.4×", ""]);
  });

  test("the report says Convex ran on the same Postgres as bunvex", () => {
    expect(read("docs/bench/E2E-VPS-2026-10-05.md")).toContain("**the same instance Convex used**");
  });

  test("the benchmark report link is the report the README cites", () => {
    expect(read("README.md")).toContain("(docs/bench/E2E-VPS-2026-10-05.md)");
    expect(BENCH.report).toBe(`${SITE.repo}/blob/main/docs/bench/E2E-VPS-2026-10-05.md`);
  });

  test("the roadmap phases are docs/parity's, in order, and a phase is done when its status line says so", () => {
    const roadmap = read("docs/parity/README.md");
    const headings = [...roadmap.matchAll(/^### (Phase \d+) — (.+)$/gm)];
    expect(headings.length).toBeGreaterThan(0);
    expect(STATUS.phases.map((p): string[] => [p.name, p.summary])).toEqual(headings.map((m) => [m[1]!, m[2]!]));
    const done = headings.map((m) =>
      roadmap
        .slice(m.index! + m[0].length)
        .trimStart()
        .startsWith("**Done.**"),
    );
    expect(STATUS.phases.map((p) => p.done)).toEqual(done);
    for (const p of STATUS.phases) expect(p.done ? p.left === "" : p.left.length > 0).toBe(true);
  });

  test("the parity counts are docs/parity's summary table, and the pill's share follows from them", () => {
    const rows = tableAfter(read("docs/parity/README.md"), "| Area |");
    expect(rows.length).toBe(PARITY.areas.length);
    expect(PARITY.areas.map((a): number[] => [a.done, a.partial, a.missing])).toEqual(
      rows.map((r) => r.slice(2).map(Number)),
    );
    expect(parityPercent()).toBe(90);
  });

  test("every link to a repository path points at a file or directory that exists", () => {
    const links = JSON.stringify({ BENCH, STATUS, FILES, FEATURES, MIGRATE, PARITY, CONFORMANCE }).match(
      new RegExp(`${SITE.repo.replaceAll(/[./]/g, "\\$&")}/(blob|tree)/main/[^"]+`, "g"),
    );
    const paths = [...(links ?? []), ...FILES.files.map((f) => f.path), ...FEATURES.map((f) => f.source)];
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) expect(existsSync(resolve(ROOT, p.replace(/^.*\/(blob|tree)\/main\//, "")))).toBe(true);
    for (const n of FILES.notWritten) expect(existsSync(resolve(ROOT, n.source))).toBe(true);
    for (const f of MIGRATE.facts) expect(existsSync(resolve(ROOT, f.source))).toBe(true);
  });

  test("the code is the tutorial example's: a whole file as it is, and only the example's own lines", () => {
    for (const f of FILES.files) {
      const source = read(f.path);
      if (f.whole) expect(f.code as string).toBe(source);
      else {
        const lines = new Set(source.split("\n").map((l) => l.trimEnd()));
        for (const line of f.code.split("\n").filter((l) => l.trim() && l.trim() !== "…"))
          expect(lines).toContain(line);
      }
    }
  });

  test("the samples import only what an app imports: bunvex/* and its own generated code", () => {
    const modules = FILES.files.flatMap((f) => [...f.code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]));
    expect(modules.length).toBeGreaterThan(0);
    for (const m of modules)
      expect(m).toMatch(/^(bunvex\/(server|values|react)|\.\/_generated\/server|\.\.\/bunvex\/_generated\/api)$/);
  });

  test("every install command is one the READMEs give", () => {
    const where = { bun: "packages/cli/README.md", docker: "docker/README.md", binary: "docker/README.md" } as const;
    for (const i of INSTALL) for (const line of i.lines) expect(read(where[i.id])).toContain(line);
  });

  test("the drivers are the five the README lists", () => {
    expect(DRIVERS.map((d): string => d.name).sort()).toEqual(
      ["MongoDB", "MySQL", "Postgres", "SQLite", "memory + log"].sort(),
    );
    expect(SHIP.map((s) => s.command)).toContain("bunvex dev");
  });

  test("the example count is the number of example apps", () => {
    const apps = readdirSync(resolve(ROOT, "examples"), { withFileTypes: true }).filter(
      (d) => d.isDirectory() && !d.name.startsWith("_"),
    );
    expect(MIGRATE.facts.some((f) => f.text.startsWith(`${apps.length} example apps`))).toBe(true);
  });
});

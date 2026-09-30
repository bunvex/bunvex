// The page's claims against their sources (SITE-01 §5): the benchmark table is README's, the roadmap is
// docs/parity's, and every link to a repository file points at a file that exists.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BENCH, blob, CODE, DRIVERS, FEATURES, SITE, STATUS } from "../src/content.ts";

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
    const report = read("docs/bench/E2E-VPS-2026-09-29.md");
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
      "cached read, req/s": [http, httpHeader, "query, cached"],
      "uncached indexed read, req/s": [http, httpHeader, "query, uncached"],
      "durable insert, req/s": [http, httpHeader, "insert, durable"],
      "action (query + mutation), req/s": [http, httpHeader, "action (query + mutation)"],
      "10 000 subscribers, delivered · p99": [fan, fanHeader, "10 000"],
    };
    expect(BENCH.rows.map((r) => r.metric)).toEqual(Object.keys(SCENARIO));
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

  test("the report says Convex ran on the same Postgres as bunvex", () => {
    expect(read("docs/bench/E2E-VPS-2026-09-29.md")).toContain("**the same instance Convex used**");
  });

  test("the benchmark report link is the report the README cites", () => {
    expect(read("README.md")).toContain("(docs/bench/E2E-VPS-2026-09-29.md)");
    expect(BENCH.report).toBe(blob("docs/bench/E2E-VPS-2026-09-29.md"));
  });

  test("the roadmap phases are docs/parity's, in order", () => {
    const headings = [...read("docs/parity/README.md").matchAll(/^### (Phase \d+) — (.+)$/gm)].map((m) => [m[1], m[2]]);
    expect(headings.length).toBeGreaterThan(0);
    expect(STATUS.phases.map((p): string[] => [p.name, p.summary])).toEqual(headings);
  });

  test("every link to a repository file points at a file that exists", () => {
    const prefix = `${SITE.repo}/blob/main/`;
    const links = JSON.stringify({ BENCH, STATUS, CODE, DRIVERS, FEATURES }).match(
      new RegExp(`${prefix.replaceAll(/[./]/g, "\\$&")}[^"]+`, "g"),
    );
    expect(links?.length).toBeGreaterThan(0);
    for (const link of links ?? []) expect(existsSync(resolve(ROOT, link.slice(prefix.length)))).toBe(true);
  });

  test("the code sample carries the target-API label (SITE-01 §5.6)", () => {
    expect(CODE.label).toBe("Target API — Convex-compatible, landing in Phase 1.");
  });

  test("the code sample imports only what ARCHITECTURE.md shows an app importing (bunvex/*, no codegen)", () => {
    const modules = CODE.files.flatMap((f) => [...f.code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]));
    expect(modules.length).toBeGreaterThan(0);
    for (const m of modules) expect(m).toMatch(/^bunvex\/(server|values)$/);
  });

  test("the drivers are the five the README lists", () => {
    expect(DRIVERS.map((d) => d.name)).toEqual(["memory + log", "SQLite", "Postgres", "MySQL", "MongoDB"]);
  });
});

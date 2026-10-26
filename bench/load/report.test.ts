import { describe, expect, test } from "bun:test";
import { bestPoint, formatCell, formatReq, markdownTable, pointFromSummary, scenarioLabel } from "./report.ts";

describe("k6 summary", () => {
  test("reads req/s and the error rate", () => {
    const point = pointFromSummary(
      { metrics: { http_reqs: { values: { rate: 12083.4 } }, bench_errors: { values: { rate: 0.002 } } } },
      "insert",
      32,
    );
    expect(point).toEqual({ scenario: "insert", vus: 32, rate: 12083.4, errors: 0.002 });
  });

  test("a summary without the error metric is a clean run", () => {
    const point = pointFromSummary({ metrics: { http_reqs: { values: { rate: 10 } } } }, "cached", 8);
    expect(point.errors).toBe(0);
  });

  test("refuses a summary that never counted requests", () => {
    expect(() => pointFromSummary({}, "cached", 8)).toThrow("http_reqs");
  });
});

describe("table", () => {
  test("keeps the fastest VU level", () => {
    const best = bestPoint([
      { scenario: "cached", vus: 8, rate: 100, errors: 0 },
      { scenario: "cached", vus: 128, rate: 90, errors: 0 },
      { scenario: "cached", vus: 32, rate: 150, errors: 0.2 },
    ]);
    expect(best?.vus).toBe(32);
  });

  test("groups thousands and marks more than 1% errors", () => {
    expect(formatReq(36495.2)).toBe("36 495");
    expect(formatReq(999)).toBe("999");
    expect(formatCell({ scenario: "increment1", vus: 8, rate: 238.2, errors: 0.02 })).toBe("238 ⚠");
    expect(formatCell({ scenario: "increment1", vus: 8, rate: 238.2, errors: 0.01 })).toBe("238");
    expect(formatCell(undefined)).toBe("—");
  });

  test("prints one row per scenario", () => {
    const table = markdownTable(
      ["memory"],
      [{ label: scenarioLabel("cached"), cells: [{ scenario: "cached", vus: 32, rate: 1000, errors: 0 }] }],
    );
    expect(table).toContain("| scenario | memory |");
    expect(table).toContain("| query, cached | 1 000 |");
  });
});

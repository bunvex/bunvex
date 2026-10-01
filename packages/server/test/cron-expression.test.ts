// Cron strings against saffron itself (STUDY-30): `fixtures/saffron-cron.json` holds 3143 cases (the
// study's vectors plus random expressions, valid and not, from random start times) answered by the exact
// saffron Convex pins (get-convex/saffron 1d84237, built with overflow checks as Convex's release build).
import { describe, expect, test } from "bun:test";
import { parseCronExpression } from "../src/cron-expression.ts";
import cases from "./fixtures/saffron-cron.json";

type Case = { expr: string; from: string | null; saffron: string };

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16);

/** What the oracle prints for `c`, computed by bunvex. */
function ours(c: Case): string {
  let cron: ReturnType<typeof parseCronExpression>;
  try {
    cron = parseCronExpression(c.expr);
  } catch (e) {
    return `PARSE_ERROR(${(e as Error).message})`;
  }
  const any = cron.any();
  if (c.from === null) return `ok any=${any}`;
  const out: string[] = [];
  let cur = Date.parse(`${c.from}Z`);
  for (let i = 0; i < 3; i++) {
    const n = cron.nextAfter(cur);
    if (n === null) {
      out.push("None");
      break;
    }
    out.push(fmt(n));
    cur = n;
  }
  return `any=${any} next=${out.join(", ")}`;
}

describe("cron expressions, as saffron", () => {
  const all = cases as Case[];
  test(`${all.length} cases match saffron (crashes aside)`, () => {
    const mismatches: string[] = [];
    for (const c of all) {
      if (c.saffron === "PANIC") continue; // saffron's L-nW underflow; checked below
      const got = ours(c);
      if (got !== c.saffron)
        mismatches.push(`${JSON.stringify(c.expr)} from ${c.from}: saffron ${c.saffron} / bunvex ${got}`);
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
  });

  test("where saffron crashes (L-nW on some Mondays), bunvex answers", () => {
    const panics = (cases as Case[]).filter((c) => c.saffron === "PANIC");
    expect(panics.length).toBeGreaterThan(0);
    for (const c of panics) expect(ours(c)).toMatch(/^any=(true|false) next=/);
  });
});

// Rule 6 of scripts/check-deps.ts (STUDY-174 F2, F3, S8; owner, 2026-10-21: Q8): every `setTimeout` / `setInterval`
// delay in the backend's code is known not to pass 2^31−1 ms, or goes through `timerDelay` or core's long timers.
import { describe, expect, test } from "bun:test";
import {
  checkedTimerCall,
  declareFields,
  literalConstants,
  metadataNaming,
  timerDelays,
  unsafeTimerDelay,
  withoutComments,
} from "./rules.ts";

/** The delays rule 6 refuses in `code`, as `call: delay`. */
function refused(code: string): string[] {
  const stripped = withoutComments(code);
  const consts = literalConstants(stripped);
  return [...timerDelays(stripped)]
    .filter((t) => checkedTimerCall(t.receiver) && unsafeTimerDelay(t.delay, consts))
    .map((t) => `${t.call}: ${t.delay}`);
}

describe("rule 6: timer delays", () => {
  test("literals, module constants of literals, timerDelay and a literal-bounded Math.min pass", () => {
    expect(
      refused(`
        const PERIOD = 60_000;
        const BACKOFF: number = 5 * 1000;
        setTimeout(f, 1000);
        setTimeout(f, 30 * 60 * 1000);
        setInterval(() => tick(), PERIOD);
        setTimeout(f, BACKOFF);
        setTimeout(f, timerDelay(due - Date.now()));
        setTimeout(f, Math.min(50, end - Date.now()));
        setInterval(f, Math.min(PERIOD, this.opts.pingMs));
        setTimeout(f);
        setTimeout(() => { a(1, 2); }, 0);
      `),
    ).toEqual([]);
  });

  test("a knob's value, an option, a parameter or a clock difference is refused", () => {
    expect(
      refused(`
        const PERIOD_MS = secondsKnob("USAGE_TRACKING_PERIOD_SECS", 3600);
        setTimeout(() => this.run(), this.periodMs);
        setInterval(f, PERIOD_MS);
        timer = setTimeout(done, ms);
        setTimeout(f, nextAt - now);
        setTimeout(f, Math.max(1, wait));
        setTimeout(f, Math.min(this.a, this.b));
      `),
    ).toEqual([
      "setTimeout: this.periodMs",
      "setInterval: PERIOD_MS",
      "setTimeout: ms",
      "setTimeout: nextAt - now",
      "setTimeout: Math.max(1, wait)",
      "setTimeout: Math.min(this.a, this.b)",
    ]);
  });

  test("a literal past the cap is refused too", () => {
    expect(refused("setTimeout(f, 30 * 86_400_000);")).toEqual(["setTimeout: 30 * 86_400_000"]);
  });

  test("a core Runtime's timers (any length by contract), comments and interface declarations are not checked", () => {
    expect(
      refused(`
        this.engine.runtime.setTimeout(done, ms);
        rt.setInterval(f, everyMs);
        // setTimeout(f, ms) in a comment
        /* setInterval(f, ms) */
        interface Runtime { setTimeout(fn: () => void, ms: number): RuntimeTimer; }
        const s = "setTimeout(f, ms)";
      `),
    ).toEqual([]);
  });

  test("the call's delay is its second argument, nested calls and strings included", () => {
    expect([...timerDelays(`setTimeout(() => g(a, b), ms, "x, y")`)].map((t) => t.delay)).toEqual(["ms"]);
  });
});

describe("rule 5: a published package's metadata", () => {
  test("the npm fields that name the upstream project are refused; a private package is not checked", () => {
    expect(
      metadataNaming({
        name: "@bunvex/x",
        description: "A port of Convex's helpers",
        keywords: ["bunvex", "convex"],
        homepage: "https://bunvex.dev",
        repository: { type: "git", url: "git+https://github.com/bunvex/bunvex.git" },
        author: "someone",
      }),
    ).toEqual(["description", "keywords"]);
    expect(metadataNaming({ name: "@bunvex/x", private: true, description: "as Convex's" })).toEqual([]);
    expect(metadataNaming({ name: "@bunvex/x", description: "Helpers for bunvex apps" })).toEqual([]);
  });

  test("names, dependencies and scripts are not metadata: a dev dependency on the reference is fine", () => {
    expect(metadataNaming({ name: "@bunvex/x", devDependencies: { "convex-helpers": "0.1.128" } })).toEqual([]);
  });
});

describe("rule 7: no `declare` class fields", () => {
  const found = (code: string) => [...declareFields(withoutComments(code))].map((f) => f.line);
  test("a declare field, with or without modifiers, optional or definite", () => {
    expect(found("class A {\n  declare readonly type: T;\n}")).toEqual([2]);
    expect(found("class A {\n  declare private readonly _x: undefined;\n  declare protected q: Q;\n}")).toEqual([2, 3]);
    expect(found("class A {\n  declare x?: number;\n  declare static y!: string;\n}")).toEqual([2, 3]);
  });
  test("not ambient declarations, merged interfaces or comments", () => {
    expect(found("declare const brand: unique symbol;\ndeclare module 'x' {}\ndeclare global {}")).toEqual([]);
    expect(found("interface A {\n  readonly type: T;\n}\nclass A {}")).toEqual([]);
    expect(found("class A {\n  // declare readonly type: T;\n  /* declare x: number; */\n}")).toEqual([]);
  });
});

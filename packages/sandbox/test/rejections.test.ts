// The child's attribution of unhandled rejections (`rejections.ts`, STUDY-171 §13), in this process, as where Bun
// reports at the end of the turn (`asIfReportedLate`: the path Bun 1.4.3 takes, right on every Bun): each call's
// rejections are its own however checkpoints interleave, a call's next checkpoint waits until its last one was checked,
// and a child left idle still hears its last marker.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asIfReportedLate, checkpoint, track, untrack } from "../src/rejections.ts";

beforeAll(() => asIfReportedLate());

/** A call that records what it is told. */
function call(id: number) {
  const seen = { failed: [] as unknown[], checked: 0, log: [] as string[] };
  track(id, {
    unhandled: (r) => {
      seen.failed.push(r instanceof Error ? r.message : r);
      seen.log.push("failed");
    },
    checked: () => {
      seen.checked++;
      seen.log.push("checked");
    },
  });
  return seen;
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 2));
  return ok();
};

describe("unhandled rejections in the child", () => {
  afterAll(() => {
    for (const id of [101, 102, 103, 104, 105]) untrack(id);
  });

  test("each call's rejections are its own, checkpoints interleaved in one turn", async () => {
    const a = call(101);
    const b = call(102);
    checkpoint(101, () => void Promise.reject(new Error("a1")));
    checkpoint(102, () => void Promise.reject(new Error("b1")));
    checkpoint(102, () => {}); // waits for 102's first check
    expect(await until(() => a.checked > 0 && b.checked > 1)).toBe(true);
    expect(a.failed).toEqual(["a1"]);
    expect(b.failed).toEqual(["b1"]);
  });

  test("a call's next checkpoint runs once its last one was checked", async () => {
    const c = call(103);
    let p!: Promise<never>;
    checkpoint(103, () => {
      p = Promise.reject(new Error("handled one checkpoint late"));
    });
    // In the same turn: a handler added in a later checkpoint is too late, as on Convex.
    checkpoint(103, () => {
      c.log.push("second");
      p.catch(() => {});
    });
    expect(await until(() => c.log.includes("second"))).toBe(true);
    expect(c.failed).toEqual(["handled one checkpoint late"]);
    expect(c.log.indexOf("failed")).toBeLessThan(c.log.indexOf("second"));
  });

  test("a rejection handled within its checkpoint is no one's", async () => {
    const d = call(104);
    checkpoint(104, () => {
      const p = Promise.reject(new Error("handled in time"));
      void Promise.resolve().then(() => p.catch(() => {}));
    });
    expect(await until(() => d.checked > 0)).toBe(true);
    expect(d.failed).toEqual([]);
  });

  test("an idle child still hears its last marker", async () => {
    let heard!: () => void;
    const checked = new Promise<string>((r) => (heard = () => r("checked")));
    track(105, { unhandled: () => {}, checked: () => heard() });
    checkpoint(105, () => {});
    // Nothing else turns the loop before the timer: the marker's report needs the turn the child forces.
    const first = await Promise.race([checked, new Promise<string>((r) => setTimeout(() => r("timer"), 300))]);
    expect(first).toBe("checked");
  });
});

// Timers of any length (STUDY-174 S8, Q8): Convex's knobs are `Duration`s tokio sleeps for whatever their length; a JS
// timer past 2^31−1 ms fires after about 1 ms. `longTimeout` / `longInterval` sleep at most that much at a time and
// re-arm for what is left. A fake host stands for the clock and the timers, so 30 days pass in no time.
import { expect, test } from "bun:test";
import { type LongTimer, longInterval, longTimeout, MAX_TIMER_MS, type TimerHost } from "../src/determinism.ts";

const DAY = 86_400_000;

/** A clock and timers that move only when `advance` says, recording every delay a timer was given. */
function fakeHost() {
  let t = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const delays: number[] = [];
  const host: TimerHost = {
    now: () => t,
    setTimeout: (fn, ms) => {
      // As Bun's: a delay past the cap fires after 1 ms.
      const d = ms > MAX_TIMER_MS ? 1 : Math.max(1, ms);
      delays.push(ms);
      const id = next++;
      pending.set(id, { at: t + d, fn });
      return id;
    },
    clearTimeout: (id) => void pending.delete(id as number),
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      t = due[1].at;
      due[1].fn();
    }
    t = end;
  };
  return { host, advance, delays, pending };
}

test("a 30-day timeout sleeps its whole length, in steps of at most 2^31−1 ms, then fires once", () => {
  const { host, advance, delays } = fakeHost();
  let fired = 0;
  longTimeout(() => fired++, 30 * DAY, host);
  expect(delays).toEqual([MAX_TIMER_MS]); // never more than the cap
  advance(MAX_TIMER_MS);
  expect(fired).toBe(0); // the first step ended: it re-armed for what is left
  expect(delays).toEqual([MAX_TIMER_MS, 30 * DAY - MAX_TIMER_MS]);
  advance(30 * DAY - MAX_TIMER_MS - 1);
  expect(fired).toBe(0);
  advance(1);
  expect(fired).toBe(1);
  advance(60 * DAY);
  expect(fired).toBe(1);
});

test("a short timeout is one plain timer", () => {
  const { host, advance, delays } = fakeHost();
  let fired = 0;
  longTimeout(() => fired++, 250, host);
  advance(249);
  expect(fired).toBe(0);
  advance(1);
  expect([fired, delays]).toEqual([1, [250]]);
});

test("cleared in the middle of a long wait, after a re-arm, it never fires and leaves no timer", () => {
  const { host, advance, pending } = fakeHost();
  let fired = 0;
  const t = longTimeout(() => fired++, 60 * DAY, host);
  advance(MAX_TIMER_MS + 5 * DAY); // past the first step, inside the second
  expect(pending.size).toBe(1);
  t.clear();
  expect(pending.size).toBe(0);
  expect(t.hasRef()).toBe(false);
  advance(100 * DAY);
  expect(fired).toBe(0);
});

test("a 40-day interval fires every 40 days, and stops when cleared from its own callback", () => {
  const { host, advance, pending } = fakeHost();
  const at: number[] = [];
  let t: LongTimer;
  t = longInterval(
    () => {
      at.push(host.now());
      if (at.length === 3) t.clear();
    },
    40 * DAY,
    host,
  );
  advance(200 * DAY);
  expect(at).toEqual([40 * DAY, 80 * DAY, 120 * DAY]);
  expect(pending.size).toBe(0);
});

test("unref and ref reach every step's timer", async () => {
  // The real host: a step's timer is Bun's own, so its ref state is observable.
  const t = longTimeout(() => {}, 30 * DAY).unref();
  expect(t.hasRef()).toBe(false);
  t.ref();
  expect(t.hasRef()).toBe(true);
  t.clear();
});

test("with the real timers, a delay past the cap does not fire early", async () => {
  let fired = 0;
  const t = longTimeout(() => fired++, MAX_TIMER_MS + 1000);
  await Bun.sleep(100);
  t.clear();
  expect(fired).toBe(0);
});

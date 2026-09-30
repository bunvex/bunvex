import { describe, expect, test } from "bun:test";
import { describeSchedule, nextRunAfter } from "../src/schedules/cron.ts";
import { formatRelative } from "../src/schedules/format.ts";

const T = Date.UTC(2026, 8, 30, 10, 20); // a Wednesday, 10:20 UTC

describe("cron schedules", () => {
  test("in words", () => {
    expect(describeSchedule({ type: "interval", seconds: 300 })).toBe("Every 5 minutes");
    expect(describeSchedule({ type: "interval", seconds: 3600 })).toBe("Every hour");
    expect(describeSchedule({ type: "interval", seconds: 90 })).toBe("Every 90 seconds");
    expect(describeSchedule({ type: "hourly", minuteUTC: 15 })).toBe("Hourly at minute 15");
    expect(describeSchedule({ type: "daily", hourUTC: 3, minuteUTC: 0 })).toBe("Daily at 03:00 UTC");
    expect(describeSchedule({ type: "weekly", dayOfWeek: 1, hourUTC: 9, minuteUTC: 30 })).toBe(
      "Weekly on Monday at 09:30 UTC",
    );
    expect(describeSchedule({ type: "monthly", day: 22, hourUTC: 0, minuteUTC: 5 })).toBe(
      "Monthly on the 22nd at 00:05 UTC",
    );
    expect(describeSchedule({ type: "monthly", day: 11, hourUTC: 0, minuteUTC: 5 })).toMatch(/the 11th/);
    expect(describeSchedule({ type: "cron", cronExpr: "0 * * * *" })).toBe("Cron 0 * * * *");
  });

  test("when they fire next, strictly after", () => {
    expect(nextRunAfter({ type: "interval", seconds: 60 }, T)).toBe(T + 60_000);
    expect(nextRunAfter({ type: "hourly", minuteUTC: 30 }, T)).toBe(Date.UTC(2026, 8, 30, 10, 30));
    expect(nextRunAfter({ type: "hourly", minuteUTC: 20 }, T)).toBe(Date.UTC(2026, 8, 30, 11, 20));
    expect(nextRunAfter({ type: "daily", hourUTC: 3, minuteUTC: 0 }, T)).toBe(Date.UTC(2026, 9, 1, 3, 0));
    expect(nextRunAfter({ type: "weekly", dayOfWeek: 1, hourUTC: 9, minuteUTC: 30 }, T)).toBe(
      Date.UTC(2026, 9, 5, 9, 30),
    );
    expect(nextRunAfter({ type: "monthly", day: 1, hourUTC: 0, minuteUTC: 0 }, T)).toBe(Date.UTC(2026, 9, 1));
    expect(nextRunAfter({ type: "cron", cronExpr: "*/30 * * * *" }, T)).toBe(Date.UTC(2026, 8, 30, 10, 30));
    expect(nextRunAfter({ type: "cron", cronExpr: "0 9 * * 1-5" }, T)).toBe(Date.UTC(2026, 9, 1, 9, 0));
    expect(() => nextRunAfter({ type: "cron", cronExpr: "* *" }, T)).toThrow(/five fields/);
  });
});

test("relative times", () => {
  expect(formatRelative(T + 2_000, T)).toBe("now");
  expect(formatRelative(T + 5 * 60_000, T)).toBe("in 5 min");
  expect(formatRelative(T - 2 * 3_600_000, T)).toBe("2 h ago");
  expect(formatRelative(T + 86_400_000, T)).toBe("in 1 day");
  expect(formatRelative(T - 3 * 86_400_000, T)).toBe("3 days ago");
});

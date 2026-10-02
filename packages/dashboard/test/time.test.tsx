import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { formatLogTime, formatTime, RelativeTime } from "../src/shell/time.tsx";

// UX2-20: one rule for times on every screen
describe("times", () => {
  const at = new Date(2026, 9, 2, 9, 5, 7, 42).getTime();
  test("grids: the date and the time to the second", () => {
    expect(formatTime(at)).toBe("2026-10-02 09:05:07");
  });
  test("log lines: milliseconds, and the date only when it is not today", () => {
    expect(formatLogTime(at, new Date(2026, 9, 2, 23, 0).getTime())).toBe("09:05:07.042");
    expect(formatLogTime(at, new Date(2026, 9, 3, 0, 1).getTime())).toBe("2026-10-02 09:05:07.042");
  });
  test("summaries: relative, with the absolute time in the tooltip", () => {
    render(<RelativeTime ms={at} now={at + 3 * 60_000} />);
    const t = screen.getByText("3 minutes ago");
    expect(t.getAttribute("title")).toBe("2026-10-02 09:05:07");
    expect(t.tagName).toBe("TIME");
  });
});

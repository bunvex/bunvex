import { describe, expect, test } from "bun:test";
import { Sparkline } from "@bunvex/ui/components/sparkline";
import { fireEvent, render, screen } from "@testing-library/react";
import { expectAccessible } from "./axe.ts";

describe("Sparkline", () => {
  test("is an image named by its summary, drawn from zero", async () => {
    const { container } = render(<Sparkline values={[0, 5, 10]} summary="Commits per second: now 10, peak 10." />);
    expect(screen.getByRole("img", { name: "Commits per second: now 10, peak 10." })).toBeDefined();
    const d = container.querySelector("path")!.getAttribute("d")!;
    // first point at the baseline (y = 100), last at 10 / (10 × 1.1) of the height
    expect(d.startsWith("M0.000,100.000")).toBe(true);
    expect(d.endsWith("L100.000,9.091")).toBe(true);
    await expectAccessible();
  });

  test("hover shows the nearest point's value and caption; leaving hides it", () => {
    const { container } = render(
      <Sparkline
        values={[1, 2, 3, 4, 5]}
        summary="s"
        formatValue={(v) => `${v} commits/s`}
        pointLabel={(i) => `${4 - i} s ago`}
      />,
    );
    const box = container.querySelector("[data-slot=sparkline]")!;
    box.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 64 }) as DOMRect;
    fireEvent.pointerMove(box, { clientX: 290 }); // 72.5 % → index 3
    expect(box.textContent).toContain("4 commits/s");
    expect(box.textContent).toContain("1 s ago");
    fireEvent.pointerLeave(box);
    expect(box.textContent).not.toContain("commits/s");
  });

  test("no line with fewer than two points", () => {
    const { container } = render(<Sparkline values={[3]} summary="waiting" />);
    expect(container.querySelector("path")).toBeNull();
  });
});

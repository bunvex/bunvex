import { describe, expect, test } from "bun:test";
import { Heatmap, heatStep } from "@bunvex/ui/components/heatmap";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expectAccessible } from "./axe.ts";

const t0 = Date.UTC(2026, 9, 2, 12);
const times = [0, 1, 2].map((i) => t0 + i * 60_000);

describe("Heatmap", () => {
  test("five steps from intensity, clamped", () => {
    expect([0, 0.19, 0.2, 0.5, 0.99, 1, 2, -1].map(heatStep)).toEqual([1, 1, 2, 3, 5, 5, 5, 1]);
  });

  test("a table: rows, time columns, each value in text; no data is not zero; hover says the value", async () => {
    render(
      <main>
        <Heatmap
          label="Failure rate"
          rows={[
            { id: "a", label: "tasks:list", cells: [0, 50, null] },
            { id: "b", label: "tasks:add", cells: [100, null, 10] },
          ]}
          times={times}
          intensity={(v) => v / 100}
          formatValue={(v) => `${v}% failed`}
          legend={["0%", "100% failed"]}
        />
      </main>,
    );
    const table = screen.getByRole("table", { name: "Failure rate" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByRole("rowheader").textContent).toBe("tasks:list");
    const cells = within(rows[0]!).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual(["0% failed", "50% failed", "no data"]);
    expect(cells.map((c) => c.getAttribute("data-step"))).toEqual(["1", "3", null]);
    expect(cells[2]!.className).toContain("border-dashed");
    fireEvent.pointerEnter(cells[1]!);
    expect(screen.getByText(/tasks:list at .*: 50% failed/)).toBeDefined();
    await expectAccessible();
  });

  test("no rows: says so", () => {
    render(
      <Heatmap
        label="x"
        rows={[]}
        times={[]}
        intensity={() => 0}
        formatValue={String}
        legend={["a", "b"]}
        empty="Nothing ran."
      />,
    );
    expect(screen.getByText("Nothing ran.")).toBeDefined();
  });
});

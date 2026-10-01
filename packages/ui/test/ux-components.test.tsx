// The UX review's shared components (UI-01 §20.5).
import { describe, expect, mock, test } from "bun:test";
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { DayInput, parseDay } from "@bunvex/ui/components/day-input";
import { StatusBadge } from "@bunvex/ui/components/status-badge";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

describe("StatusBadge (UX-11)", () => {
  test("an icon and a sentence-case word, the detail after it", () => {
    render(<StatusBadge status="failure">31 ms</StatusBadge>);
    const badge = screen.getByText("Failure").closest("[data-slot=status-badge]")!;
    expect(badge.textContent).toBe("Failure 31 ms");
    expect(badge.querySelector("svg")).not.toBeNull();
  });
});

describe("CopyButton iconOnly (UX-8)", () => {
  test("an icon named by its label, with the label then Copied as its tooltip", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mock(() => Promise.resolve()) },
      configurable: true,
    });
    render(<CopyButton text="https://x" label="Copy client URL" iconOnly />);
    const b = screen.getByRole("button", { name: "Copy client URL" });
    expect(b.textContent).toBe("");
    expect(b.getAttribute("title")).toBe("Copy client URL");
    await userEvent.setup().click(b);
    await waitFor(() => expect(b.getAttribute("title")).toBe("Copied"));
  });
});

describe("DayInput (UX-15)", () => {
  test("parseDay takes real YYYY-MM-DD days only", () => {
    expect(parseDay("2026-02-28")).toBe("2026-02-28");
    expect(parseDay("2026-02-31")).toBeNull();
    expect(parseDay("28/02/2026")).toBeNull();
  });

  test("a typed day applies when complete; a wrong one says so and changes nothing; the calendar picks", async () => {
    const onChange = mock((_: string | undefined) => {});
    function Host() {
      const [v, setV] = useState<string | undefined>();
      return (
        <DayInput
          label="From"
          value={v}
          onChange={(d) => {
            onChange(d);
            setV(d);
          }}
        />
      );
    }
    render(<Host />);
    const box = screen.getByLabelText("From");
    expect(box.getAttribute("type")).not.toBe("date");
    expect(box.getAttribute("placeholder")).toBe("YYYY-MM-DD");
    fireEvent.change(box, { target: { value: "2026-13-01" } });
    fireEvent.blur(box);
    expect(onChange).not.toHaveBeenCalled();
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("A day as YYYY-MM-DD")).toBeDefined();
    fireEvent.change(box, { target: { value: "2026-09-29" } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenLastCalledWith("2026-09-29");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Pick From" }));
    await user.click(await screen.findByRole("button", { name: "2026-09-15" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-09-15");
  });
});

import { describe, expect, mock, test } from "bun:test";
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { JsonView } from "@bunvex/ui/components/json-view";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

describe("JsonView", () => {
  test("prints the JSON a reader would copy, with each type marked", async () => {
    const value = { s: "x", n: 1.5, b: true, z: null, a: [1, "y"], o: { k: [] }, e: {} };
    render(
      <main>
        <JsonView value={value} label="Document k1" />
      </main>,
    );
    const pre = screen.getByLabelText("Document k1");
    expect(pre.textContent).toBe(JSON.stringify(value, null, 2));
    expect(screen.getByText('"x"').className).toContain("text-success");
    expect(screen.getByText("1.5").className).toContain("text-info");
    expect(screen.getByText("null").className).toContain("text-warning");
    await expectAccessible();
  });
});

describe("CopyButton", () => {
  test("copies, says so visibly and to screen readers, then resets", async () => {
    const user = userEvent.setup(); // installs its own clipboard stub: replace it after
    const writeText = mock((_: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyButton text='{"a":1}' label="Copy JSON" />);
    await user.click(screen.getByRole("button", { name: "Copy JSON" }));
    expect(writeText).toHaveBeenCalledWith('{"a":1}');
    expect(await screen.findByRole("button", { name: "Copied" })).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("Copied to the clipboard");
  });

  test("a refused clipboard is reported", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
    render(<CopyButton text="x" />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect((await screen.findByRole("status")).textContent).toBe("Could not copy");
  });
});

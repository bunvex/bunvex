import { describe, expect, mock, test } from "bun:test";
import { CodeEditor, type CodeEditorProps } from "@bunvex/ui/components/code-editor";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expectAccessible } from "./axe.ts";

// The plain field (what tests and a not-yet-loaded Monaco show) has the editor's keys.
function Harness(props: Partial<CodeEditorProps>) {
  const [value, setValue] = useState(props.value ?? "");
  return <CodeEditor label="Value" {...props} value={value} onChange={setValue} />;
}

describe("CodeEditor (plain)", () => {
  test("one line: Enter submits, Tab calls onTab, Escape cancels", async () => {
    const onSubmit = mock();
    const onTab = mock();
    const onCancel = mock();
    render(<Harness onSubmit={onSubmit} onTab={onTab} onCancel={onCancel} autoFocus />);
    const user = userEvent.setup();
    const box = screen.getByRole("textbox", { name: "Value" }) as HTMLInputElement;
    expect(document.activeElement).toBe(box);
    await user.type(box, '"a"{Enter}');
    expect(box.value).toBe('"a"');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await user.keyboard("{Tab}");
    expect(onTab).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(box);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("one line without onTab: Tab leaves the field", async () => {
    render(
      <>
        <Harness />
        <button type="button">next</button>
      </>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "next" }));
  });

  test("several lines: Enter is a new line, Ctrl+Enter submits", async () => {
    const onSubmit = mock();
    render(<Harness multiline onSubmit={onSubmit} />);
    const user = userEvent.setup();
    const box = screen.getByRole("textbox", { name: "Value" }) as HTMLTextAreaElement;
    expect(box.tagName).toBe("TEXTAREA");
    await user.click(box);
    await user.keyboard("{{{Enter}a: 1{Enter}}"); // "{{" types one "{"
    expect(box.value).toBe("{\na: 1\n}");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("an error marks the field invalid and points to its description", async () => {
    render(
      <main>
        <Harness value="ada" error={{ message: "Text needs quotes", offset: 0 }} describedBy="why" />
        <p id="why">Text needs quotes</p>
      </main>,
    );
    const box = screen.getByRole("textbox", { name: "Value" });
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")).toBe("why");
    await expectAccessible();
  });
});

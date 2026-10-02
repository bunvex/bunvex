import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { changesOf } from "../src/settings/screen.tsx";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const mockSource = (over: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 7, now: NOW, executions: 20, documents: { tasks: 5, users: 5 }, ...over });

function mount(path = "/settings/environment-variables", source = mockSource()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source} history={history} />);
  return { history, source };
}
const list = () => screen.getByRole("list", { name: "Environment variables" });
/** A variable's row, shown or being edited (then its name is in the Name box). */
const item = (name: string) =>
  within(list())
    .getAllByRole("listitem")
    .find((li) => li.textContent?.startsWith(name) || li.querySelector("input")?.value === name)!;
const loaded = () => screen.findByRole("list", { name: "Environment variables" });
const vars = async (src: MockDataSource) =>
  Object.fromEntries((await src.listEnvironmentVariables()).map((v) => [v.name, v.value]));

beforeEach(() => localStorage.clear());

test("the batch a set of rows makes: a rename is a delete and a set", () => {
  const original = { name: "A", value: "1" };
  const row = { key: "k", original, name: "A", value: "1", deleted: false, editing: false };
  expect(changesOf([row])).toEqual([]);
  expect(changesOf([{ ...row, value: "2" }])).toEqual([{ name: "A", value: "2" }]);
  expect(changesOf([{ ...row, name: "B" }])).toEqual([
    { name: "A", value: null },
    { name: "B", value: "1" },
  ]);
  expect(changesOf([{ ...row, deleted: true }])).toEqual([{ name: "A", value: null }]);
  expect(changesOf([{ key: "n", name: "C", value: "3", deleted: false, editing: true }])).toEqual([
    { name: "C", value: "3" },
  ]);
});

describe("Settings: environment variables", () => {
  test("values are hidden until shown", async () => {
    mount("/settings/environment-variables");
    await loaded();
    // the page's actions sit in Bar 1, and its title is not repeated in the body (UX2-9)
    expect(screen.queryByRole("heading", { level: 2, name: "Environment variables" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add a variable" }).closest("[class*='min-h-11']")).not.toBeNull();
    const secret = item("AUTH_SECRET");
    expect(secret.textContent).not.toContain("s3cr3t");
    expect(within(secret).getByText("Hidden value")).toBeDefined();
    const user = userEvent.setup();
    const show = within(secret).getByRole("button", { name: "Show the value of AUTH_SECRET" });
    await user.click(show);
    expect(show.getAttribute("aria-pressed")).toBe("true");
    expect(item("AUTH_SECRET").textContent).toContain("s3cr3t-7f2c9a1e44b0d86f");
    await expectAccessible();
  });

  test("edit a value, then Save: one batch, said, and the list reloads", async () => {
    const { source } = mount();
    await loaded();
    const user = userEvent.setup();
    await user.click(within(item("LOG_LEVEL")).getByRole("button", { name: "Edit LOG_LEVEL" }));
    const value = within(item("LOG_LEVEL")).getByRole("textbox", { name: "Value" });
    await user.clear(value);
    await user.type(value, "debug");
    await user.click(within(item("LOG_LEVEL")).getByRole("button", { name: "Done" }));
    expect(screen.getByText("1 unsaved change")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved 1 change.");
    expect((await vars(source)).LOG_LEVEL).toBe("debug");
    expect(screen.queryByText(/unsaved/)).toBeNull();
  });

  test("a new variable: a bad name blocks Save and says why; a good one is added", async () => {
    const { source } = mount();
    await loaded();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add a variable" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(document.activeElement).toBe(name);
    await user.type(name, "1BAD");
    expect(screen.getByText("Start with a letter; use only letters, digits and underscores.")).toBeDefined();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    await user.clear(name);
    await user.type(name, "LOG_LEVEL");
    expect(screen.getByText("LOG_LEVEL is used twice.")).toBeDefined();
    await user.clear(name);
    await user.type(name, "FEATURE_FLAG");
    await user.type(screen.getByRole("textbox", { name: "Value" }), '"on"');
    expect(screen.getByText(/The quotes are part of the value/)).toBeDefined(); // a warning, not an error
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved 1 change.");
    expect((await vars(source)).FEATURE_FLAG).toBe('"on"');
  });

  test("delete, undo, delete again and Save; Discard drops pending changes", async () => {
    const { source } = mount();
    await loaded();
    const user = userEvent.setup();
    await user.click(within(item("SITE_URL")).getByRole("button", { name: "Delete SITE_URL" }));
    expect(within(item("SITE_URL")).getByText("Deleted when you save")).toBeDefined();
    await user.click(within(item("SITE_URL")).getByRole("button", { name: "Keep SITE_URL" }));
    expect(screen.queryByText(/unsaved/)).toBeNull();
    await user.click(within(item("RESEND_API_KEY")).getByRole("button", { name: "Delete RESEND_API_KEY" }));
    await user.click(within(item("SITE_URL")).getByRole("button", { name: "Delete SITE_URL" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("Deleted when you save")).toBeNull();
    await user.click(within(item("SITE_URL")).getByRole("button", { name: "Delete SITE_URL" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved 1 change.");
    expect("SITE_URL" in (await vars(source))).toBe(false);
    expect("RESEND_API_KEY" in (await vars(source))).toBe(true);
  });

  test("rename: the old name goes, the new one keeps the value", async () => {
    const { source } = mount();
    await loaded();
    const user = userEvent.setup();
    await user.click(within(item("SITE_URL")).getByRole("button", { name: "Edit SITE_URL" }));
    const name = within(item("SITE_URL")).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "PUBLIC_URL");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved 2 changes.");
    const after = await vars(source);
    expect("SITE_URL" in after).toBe(false);
    expect(after.PUBLIC_URL).toBe("http://localhost:5173");
  });

  test("a pasted .env file becomes new rows", async () => {
    const { source } = mount();
    await loaded();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add a variable" }));
    fireEvent.paste(screen.getByRole("textbox", { name: "Name" }), {
      clipboardData: { getData: () => '# from .env\nA_ONE=1\nexport B_TWO="two words"\n' },
    });
    expect(screen.getAllByRole("textbox", { name: "Name" }).map((i) => (i as HTMLInputElement).value)).toEqual([
      "A_ONE",
      "B_TWO",
    ]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved 2 changes.");
    const after = await vars(source);
    expect([after.A_ONE, after.B_TWO]).toEqual(["1", "two words"]);
  });

  test("a batch the source refuses keeps the changes, with the reason", async () => {
    const source = mockSource();
    source.updateEnvironmentVariables = () => Promise.reject(new Error("too many variables"));
    mount(undefined, source);
    await loaded();
    const user = userEvent.setup();
    await user.click(within(item("LOG_LEVEL")).getByRole("button", { name: "Delete LOG_LEVEL" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not save: too many variables");
    expect(screen.getByText("1 unsaved change")).toBeDefined();
  });

  test("without writeEnvironmentVariables: shown and copied, not changed", async () => {
    mount(
      undefined,
      mockSource({ capabilities: { operations: ["viewData", "viewEnvironmentVariables"], readOnly: false } }),
    );
    await loaded();
    expect(within(item("LOG_LEVEL")).getByRole("button", { name: "Show the value of LOG_LEVEL" })).toBeDefined();
    expect(within(item("LOG_LEVEL")).getByRole("button", { name: "Copy LOG_LEVEL" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a variable" })).toBeNull();
  });

  test("a read-only credential cannot change them either", async () => {
    mount(
      undefined,
      mockSource({
        capabilities: { operations: ["viewEnvironmentVariables", "writeEnvironmentVariables"], readOnly: true },
      }),
    );
    await loaded();
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
  });

  test("without viewEnvironmentVariables they are not shown", async () => {
    mount(undefined, mockSource({ capabilities: { operations: ["viewData"], readOnly: false } }));
    await screen.findByText("This credential cannot view environment variables.");
  });

  test("a source without environment variables says so", async () => {
    const source = mockSource();
    Object.defineProperty(source, "listEnvironmentVariables", { value: undefined });
    mount(undefined, source);
    await screen.findByText("This deployment does not offer environment variables yet.");
  });
});

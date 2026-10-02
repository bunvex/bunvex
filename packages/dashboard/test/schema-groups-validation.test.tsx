// The Schema screen's follow-ups (STUDY-12 §14.6–14.7, UI-01 §21.4): a group renamed (kept per deployment; an
// empty name gives it its own back), and a schema validation in progress or failed, said on the Schema bar and
// in the Database schema panel. Dragging is checked in a real browser (the e2e).
import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readSavedLayout, savedPosition, writeSavedLayout } from "../src/schema/saved-layout.ts";
import { validatedShare } from "../src/schema/validation.tsx";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 5, now: NOW, documents: { tasks: 10, users: 6, messages: 3, imports: 3 }, ...opts });
function mount(path: string, src = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}

beforeEach(() => localStorage.clear());

describe("the saved layout", () => {
  test("names and positions round-trip; a position applies only in the same group; damage reads as empty", () => {
    writeSavedLayout("d", { names: { g1: "Core" }, positions: { tasks: { x: 1, y: 2, parent: "g1" } } });
    const l = readSavedLayout("d");
    expect(l.names).toEqual({ g1: "Core" });
    expect(savedPosition(l, "tasks", "g1")).toEqual({ x: 1, y: 2 });
    expect(savedPosition(l, "tasks", null)).toBeUndefined();
    localStorage.setItem("bunvex:schema-layout:d", "{not json");
    expect(readSavedLayout("d")).toEqual({ names: {}, positions: {} });
    writeSavedLayout("d", { names: {}, positions: {} });
    expect(localStorage.getItem("bunvex:schema-layout:d")).toBeNull();
  });

  test("validation progress is capped at 99 % and unknown until the total is", () => {
    expect(validatedShare({ state: "validating", numDocsValidated: 5, totalDocs: null })).toBeNull();
    expect(validatedShare({ state: "validating", numDocsValidated: 50, totalDocs: 100 })).toBe(0.5);
    expect(validatedShare({ state: "validating", numDocsValidated: 120, totalDocs: 100 })).toBe(0.99);
  });
});

describe("the Schema screen's groups", () => {
  test("a group is renamed in place, kept for the deployment, and an empty name restores its own", async () => {
    mount("/schema");
    const user = userEvent.setup();
    const rename = await screen.findByRole("button", { name: /^Rename the group / });
    const own = rename.getAttribute("aria-label")!.replace("Rename the group ", "");
    await user.click(rename);
    const box = screen.getByRole("textbox", { name: `Name of the group ${own}` });
    await user.clear(box);
    await user.type(box, "Core{Enter}");
    await screen.findByRole("button", { name: "Rename the group Core" });
    expect(Object.values(readSavedLayout("default").names)).toEqual(["Core"]);
    await user.click(screen.getByRole("button", { name: "Rename the group Core" }));
    await user.type(screen.getByRole("textbox", { name: "Name of the group Core" }), " typed{Escape}");
    // Escape leaves the name as it was
    expect(screen.getByRole("button", { name: "Rename the group Core" })).toBeDefined();
    expect(Object.values(readSavedLayout("default").names)).toEqual(["Core"]);
    await user.click(screen.getByRole("button", { name: "Rename the group Core" }));
    await user.clear(screen.getByRole("textbox", { name: "Name of the group Core" }));
    await user.keyboard("{Enter}");
    await screen.findByRole("button", { name: `Rename the group ${own}` });
    expect(readSavedLayout("default").names).toEqual({});
    await expectAccessible();
  });
});

describe("schema validation", () => {
  test("in progress: said on the Schema bar with its share; it ends accepted", async () => {
    const src = source();
    src.simulateSchemaValidation("pass", 60_000);
    mount("/schema", src);
    await screen.findByText("Validating the schema against the stored documents…");
    const s = await src.getSchema();
    expect(s.validation?.state).toBe("validating");
    // the mock's clock runs on; a finished validation that passed leaves nothing to say
    src.simulateSchemaValidation("pass", 0);
    expect((await src.getSchema()).validation).toBeUndefined();
  });

  test("failed: the Database schema panel says how many documents and opens one", async () => {
    const src = source();
    src.simulateSchemaValidation("fail", 0);
    const { history } = mount("/database/tasks?panel=schema", src);
    const panel = await screen.findByRole("complementary", { name: "Schema of tasks" });
    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent).toMatch(/Schema validation failed: \d+ documents? (does|do) not match\./);
    const link = within(alert).getAllByRole("link")[0]!;
    const [table, id] = link.textContent!.split(" ");
    await userEvent.setup().click(link);
    await waitFor(() => expect(history.location.pathname).toBe(`/database/${table}`));
    expect(new URLSearchParams(history.location.search).get("doc")).toBe(id!);
  });
});

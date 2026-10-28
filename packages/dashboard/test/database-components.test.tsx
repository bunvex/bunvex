// The Database screen's component picker (STUDY-152 §4), as Convex's (`useNents.ts`, `NentSwitcherList.tsx`):
// shown only when the app uses components, "app" first, the unmounted ones last and marked; the choice in the URL;
// the screen then reads and writes in the component's namespace, and an unmounted one's data is read-only.
import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { type MockComponent, MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const COMPONENTS: MockComponent[] = [
  {
    path: "counter",
    tables: {
      counts: [
        { name: "a", value: 1 },
        { name: "b", value: 2 },
      ],
      shards: [{ n: 0 }],
    },
  },
  { path: "old", state: "unmounted", tables: { leftovers: [{ x: 1 }] } },
];
const COUNTER = "component_counter";
const OLD = "component_old";

function mount(path: string, components: MockComponent[] = COMPONENTS) {
  const source = new MockDataSource({
    seed: 5,
    now: NOW,
    documents: { tasks: 6, users: 3, messages: 2, imports: 1 },
    executions: 5,
    components,
  });
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source} history={history} />);
  return { history, source };
}
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });
const tableLinks = () =>
  within(screen.getByRole("navigation", { name: "Tables" }))
    .getAllByRole("link")
    .map((l) => l.textContent);
// the section column's picker (the phone's, above the table, is hidden from lg)
const picker = () =>
  within(screen.getByRole("navigation", { name: "Tables" })).getByRole("combobox", { name: "Component" });

describe("the Database screen's component picker", () => {
  test("no components: no picker, the app's tables", async () => {
    mount("/database", []);
    await heading("imports");
    expect(within(screen.getByRole("navigation", { name: "Tables" })).queryByRole("combobox")).toBeNull();
  });

  test("app first, then the mounted components, the unmounted last and marked; picking one opens its tables", async () => {
    const { history } = mount("/database");
    await heading("imports");
    expect(picker().textContent).toContain("app");
    await expectAccessible();
    const user = userEvent.setup();
    await user.click(picker());
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["app", "counter", "old*"]);
    await user.click(screen.getByRole("option", { name: "counter" }));
    // its first table, the component kept in the URL
    await heading("counts");
    expect(history.location.pathname).toBe("/database/counts");
    expect(new URLSearchParams(history.location.search).get("component")).toBe(COUNTER);
    expect(tableLinks()).toEqual(["counts2", "shards1"]);
    // a link to another of its tables keeps the component
    await user.click(screen.getByRole("link", { name: /^shards/ }));
    await heading("shards");
    expect(new URLSearchParams(history.location.search).get("component")).toBe(COUNTER);
    expect(screen.getByRole("grid", { name: "Documents in shards" })).toBeDefined();
    // back to the app's tables
    await user.click(picker());
    await user.click(await screen.findByRole("option", { name: "app" }));
    await heading("imports");
    expect(new URLSearchParams(history.location.search).get("component")).toBeNull();
  });

  test("a component's documents, and its writes in its own namespace", async () => {
    const { source } = mount(`/database/counts?component=${COUNTER}`);
    await heading("counts");
    const grid = screen.getByRole("grid", { name: "Documents in counts" });
    expect(within(grid).getAllByRole("row").length).toBe(3); // the header and two documents
    expect(screen.getByRole("button", { name: "Add documents" })).toBeDefined();
    await source.inComponent(COUNTER).insertDocuments("counts", [{ name: "c", value: 3 }]);
    await waitFor(() => expect(within(grid).getAllByRole("row").length).toBe(4));
    // the app's tables are untouched
    expect((await source.listTables()).some((t) => t.name === "counts")).toBe(false);
  });

  test("an unmounted component: its data shown read-only, as Convex's", async () => {
    mount(`/database/leftovers?component=${OLD}`);
    await heading("leftovers");
    expect(screen.getAllByText("This component is unmounted. Its data is read-only.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Add documents" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Create table/ })).toBeNull();
  });

  test("an id the list does not have is the app's (Convex drops it)", async () => {
    mount("/database?component=nope");
    await heading("imports");
    expect(tableLinks()[0]).toContain("imports");
  });
});

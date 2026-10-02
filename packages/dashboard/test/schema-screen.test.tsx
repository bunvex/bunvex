import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard, type SchemaInfo, type ValidatorJson } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 5, now: NOW, documents: { tasks: 10, users: 6, messages: 3, imports: 3 }, ...opts });

function mount(path: string, src = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}
const heading = () => screen.findByRole("heading", { level: 1, name: "Schema" });
const lit = (value: string): ValidatorJson => ({ type: "literal", value });

beforeEach(() => localStorage.clear());

describe("the Schema screen", () => {
  test("is in the navigation's Data group, between Database and Files", async () => {
    mount("/schema");
    await heading();
    const nav = screen.getAllByRole("link").map((a) => a.textContent?.trim());
    expect(nav.indexOf("Schema")).toBe(nav.indexOf("Database") + 1);
    expect(nav.indexOf("Files")).toBe(nav.indexOf("Schema") + 1);
  });

  test("counts the tables and references, and a table opens beside the diagram from the URL", async () => {
    const { history } = mount("/schema?table=tasks");
    await heading();
    await screen.findByText(/4 tables · 2 references/);
    const panel = await screen.findByRole("complementary", { name: "tasks" });
    const fields = within(panel).getByRole("region", { name: "Fields" });
    expect(within(fields).getByText("owner")).toBeDefined();
    expect(within(fields).getByText('Id<"users">')).toBeDefined();
    expect(within(panel).getByRole("button", { name: "users" })).toBeDefined(); // points at
    expect(within(panel).getByText("by_owner")).toBeDefined(); // its indexes
    const open = within(panel).getByRole("link", { name: "Open in Database" });
    expect(open.getAttribute("href")).toBe("/database/tasks");
    await expectAccessible();
    await userEvent.setup().click(within(panel).getByRole("button", { name: "Close the panel" }));
    await waitFor(() => expect(history.location.search).toBe(""));
  });

  test("a table node, focused, opens with Enter; its name says what it references", async () => {
    const { history } = mount("/schema");
    await heading();
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node-table").length).toBe(4));
    const tasks = document.querySelector<HTMLElement>('.react-flow__node-table[data-id="tasks"]')!;
    expect(tasks.getAttribute("aria-label")).toBe("Table tasks: 5 fields, references users");
    tasks.focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(history.location.search).toBe("?table=tasks"));
  });

  test("a card: the table icon, its fields, then its own indexes (no system ones), as Convex's", async () => {
    mount("/schema");
    await heading();
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node-table").length).toBe(4));
    const tasks = document.querySelector<HTMLElement>('.react-flow__node-table[data-id="tasks"]')!;
    expect(tasks.querySelector("svg.lucide-table-2, svg.lucide-table2")).not.toBeNull();
    const indexes = tasks.querySelector<HTMLElement>("[data-indexes]")!;
    const rows = within(indexes)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows).toEqual(["by_ownerowner", "by_done_prioritydone, priority", "by_texttext"]);
    expect(indexes.textContent).not.toContain("by_creation_time");
    expect(indexes.textContent).not.toContain("by_id");
  });

  test('an Id<"users"> type goes to the users table: lit a moment and focused, the panel unchanged', async () => {
    const { history } = mount("/schema");
    await heading();
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node-table").length).toBe(4));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: 'owner: Id<"users">, go to table users' }));
    const users = document.querySelector<HTMLElement>('.react-flow__node-table[data-id="users"]')!;
    await waitFor(() => expect(users.querySelector(":scope > div")!.className).toContain("ring-info"));
    await waitFor(() => expect(document.activeElement === users).toBe(true));
    expect(history.location.search).toBe("");
    await waitFor(() => expect(users.querySelector(":scope > div")!.className).not.toContain("ring-info"), {
      timeout: 2500,
    });
  });

  test("an undeclared table is flagged and typed from its documents", async () => {
    mount("/schema?table=imports");
    const panel = await screen.findByRole("complementary", { name: "imports" });
    expect(within(panel).getByText(/not declared in the schema/)).toBeDefined();
    expect(within(panel).getByText("source")).toBeDefined();
  });

  test("search finds tables, fields and indexes, and a hit opens the table", async () => {
    const { history } = mount("/schema");
    await heading();
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole("searchbox", { name: /Search groups, tables, fields and indexes/ }),
      "owner",
    );
    const hits = within(screen.getByRole("list", { name: "Search results" })).getAllByRole("button");
    expect(hits.map((h) => h.textContent)).toEqual(['tasks.ownerId<"users">', "tasks.by_ownerindex"]);
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(history.location.search).toBe("?table=tasks"));
  });

  test("a union document type: its members one at a time, the discriminator marked; long types expand", async () => {
    const src = source();
    src.getSchema = async (): Promise<SchemaInfo> => ({
      enforced: true,
      tables: [
        {
          name: "users",
          validator: {
            type: "union",
            value: [
              {
                type: "object",
                value: {
                  kind: { fieldType: lit("person"), optional: false },
                  prefs: {
                    fieldType: { type: "object", value: { theme: { fieldType: { type: "string" }, optional: false } } },
                    optional: true,
                  },
                },
              },
              {
                type: "object",
                value: {
                  kind: { fieldType: lit("bot"), optional: false },
                  owner: { fieldType: { type: "id", tableName: "users" }, optional: false },
                },
              },
            ],
          },
        },
      ],
    });
    mount("/schema?table=users", src);
    const panel = await screen.findByRole("complementary", { name: "users" });
    const user = userEvent.setup();
    expect(within(panel).getByText("discriminator")).toBeDefined();
    expect(within(panel).getByText("prefs")).toBeDefined();
    await user.click(within(panel).getByRole("button", { name: "Expand the type of prefs" }));
    expect(within(panel).getByText("{ theme: string }")).toBeDefined();
    await user.click(within(panel).getByRole("button", { name: '"bot"' }));
    expect(within(panel).queryByText("prefs")).toBeNull();
    expect(within(panel).getByText("owner")).toBeDefined();
  });

  test("no tables at all: it says how to declare a schema", async () => {
    mount("/schema", source({ tables: false }));
    await heading();
    expect(await screen.findByRole("region", { name: "This deployment doesn't have any tables" })).toBeDefined();
    expect(screen.getByText("bunvex/schema.ts")).toBeDefined();
  });

  test("a credential that cannot view data is told so", async () => {
    mount("/schema", source({ capabilities: { operations: ["viewEnvironmentVariables"], readOnly: true } }));
    expect(await screen.findByRole("region", { name: "You cannot view the schema" })).toBeDefined();
  });

  test("the grouping choice is kept for the deployment", async () => {
    mount("/schema");
    await heading();
    const box = await screen.findByRole("checkbox", { name: "Group related tables" });
    expect((box as HTMLInputElement).checked).toBe(true);
    await userEvent.setup().click(box);
    expect(localStorage.getItem("bunvex:schema-groups:default")).toBe("off");
  });
});

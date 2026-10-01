import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describeEvent } from "../src/history/describe.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const mockSource = (over: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 7, now: NOW, executions: 20, documents: { tasks: 5, users: 5, imports: 3 }, ...over });

function mount(path = "/history", source = mockSource()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source} history={history} />);
  return { history, source };
}
const rows = () =>
  within(screen.getByRole("grid", { name: "Audit log" }))
    .getAllByRole("row")
    .slice(1);
const what = (r: HTMLElement) => within(r).getAllByRole("gridcell")[1]!.textContent;
const params = (h: ReturnType<typeof createMemoryHistory>) =>
  Object.fromEntries(new URLSearchParams(h.location.search));
const loaded = () => waitFor(() => expect(rows().length).toBeGreaterThan(3));

beforeEach(() => localStorage.clear());

test("events in words", () => {
  const e = (action: string, metadata: Record<string, never> | Record<string, unknown>) =>
    describeEvent({ id: "1", time: 0, action, author: null, metadata: metadata as never });
  expect(e("add_documents", { table: "tasks", count: 3 })).toBe("Added 3 documents to tasks");
  expect(e("add_documents", { table: "tasks", count: 1452 })).toBe("Added 1,452 documents to tasks");
  expect(e("pause_deployment", {})).toBe("Paused the deployment");
  expect(e("request_export", { format: "zip", include_storage: true })).toBe(
    "Requested a snapshot export, with the stored files",
  );
  expect(e("snapshot_import", { table_names: ["notes"], import_mode: "replace", count: 2 })).toBe(
    "Imported 2 documents into notes (replacing)",
  );
  expect(e("unpause_deployment", {})).toBe("Resumed the deployment");
  expect(e("delete_documents", { table: "tasks", count: 1 })).toBe("Deleted 1 document from tasks");
  expect(e("clear_tables", { tables: ["messages"], count: 3 })).toBe("Cleared messages (3 documents)");
  expect(e("delete_environment_variable", { variable_name: "LOG_LEVEL" })).toBe(
    "Deleted environment variable LOG_LEVEL",
  );
  expect(e("cancel_all_scheduled_functions", { function: "tasks:toggle", count: 2 })).toBe(
    "Canceled 2 scheduled runs of tasks:toggle",
  );
  expect(e("something_new", {})).toBe("something_new");
});

describe("the History screen", () => {
  test("the audit log, newest first, in words, with who did it", async () => {
    const { source } = mount();
    await screen.findByRole("heading", { level: 1, name: "History" });
    await loaded();
    const events = (await source.listAuditEvents({ numItems: 100, cursor: null })).page;
    expect(rows().map(what)).toEqual(events.slice(0, rows().length).map(describeEvent));
    expect(within(rows()[0]!).getAllByRole("gridcell")[2]!.textContent).toBe("admin key");
    await expectAccessible();
  });

  test("actions in a filter column with their counts, in the URL; a day range with nothing in it says so", async () => {
    const { history } = mount();
    await loaded();
    const user = userEvent.setup();
    const column = screen.getByRole("navigation", { name: "History filters" });
    const actions = within(column).getByRole("region", { name: "Action" });
    const box = (name: string) => within(actions).getByRole("checkbox", { name });
    // the count of each action among the loaded events, in text
    expect(box("Deployed functions").closest("li")!.lastElementChild!.textContent).toBe("3");
    // keep only deploys: uncheck every other action
    for (const other of within(actions).getAllByRole("checkbox"))
      if (other !== box("Deployed functions")) await user.click(other);
    await waitFor(() => expect(params(history)).toEqual({ action: "push_config" }));
    await waitFor(() => expect(rows().every((r) => what(r) === "Deployed functions")).toBe(true));
    expect(rows().length).toBe(3);
    // the counts stay those of every action, so the others can be added back
    expect(box("Deployed functions").closest("li")!.lastElementChild!.textContent).toBe("3");
    expect(box("Added documents").closest("li")!.lastElementChild!.textContent).toBe("1");
    await user.click(box("Added documents"));
    await waitFor(() => expect(params(history)).toEqual({ action: "push_config,add_documents" }));
    fireEvent.change(within(column).getByLabelText("Until"), { target: { value: "2020-01-01" } });
    fireEvent.blur(within(column).getByLabelText("Until")); // a typed day applies once complete (UX-15)
    await screen.findByText("Nothing matches these filters.");
    await user.click(within(column).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(params(history)).toEqual({}));
  });

  test("a day preset sets the range from today; the open event follows the current row", async () => {
    const { history } = mount();
    await loaded();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Last 7 days" }));
    const pad = (n: number) => String(n).padStart(2, "0");
    const d = new Date();
    const week = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6);
    await waitFor(() =>
      expect(params(history)).toEqual({
        from: `${week.getFullYear()}-${pad(week.getMonth() + 1)}-${pad(week.getDate())}`,
      }),
    );
    await user.click(screen.getByRole("radio", { name: "Any day" }));
    await waitFor(() => expect(params(history)).toEqual({}));
    await waitFor(() => expect(rows().length).toBeGreaterThan(2));
    await user.click(within(rows()[0]!).getAllByRole("gridcell")[1]!);
    await screen.findByRole("complementary");
    const first = params(history).event;
    expect(first).toBeDefined();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(params(history).event).not.toBe(first));
  });

  test("what the dashboard does is recorded and shows up live", async () => {
    const { source } = mount();
    await loaded();
    await source.insertDocuments("imports", [{ label: "a" }, { label: "b" }]);
    await waitFor(() => expect(what(rows()[0]!)).toBe("Added 2 documents to imports"));
    await source.updateEnvironmentVariables([{ name: "LOG_LEVEL", value: null }]);
    await waitFor(() => expect(what(rows()[0]!)).toBe("Deleted environment variable LOG_LEVEL"));
  });

  test("an event's details show its metadata", async () => {
    const { history, source } = mount();
    await loaded();
    const [latest] = (await source.listAuditEvents({ numItems: 1, cursor: null })).page;
    const user = userEvent.setup();
    await user.click(within(rows()[0]!).getAllByRole("gridcell")[0]!);
    await waitFor(() => expect(params(history)).toEqual({ event: latest!.id }));
    const panel = await screen.findByRole("complementary", { name: "Event" });
    expect(within(panel).getByText(latest!.action)).toBeDefined();
    expect(within(panel).getByRole("region", { name: "Details" }).textContent).toContain("modules: 4");
  });

  test("without viewAuditLog the log is not fetched", async () => {
    mount(undefined, mockSource({ capabilities: { operations: ["viewData"], readOnly: false } }));
    await screen.findByText("This credential cannot view the audit log.");
  });

  test("a source without an audit log says so", async () => {
    const source = mockSource();
    Object.defineProperty(source, "listAuditEvents", { value: undefined });
    mount(undefined, source);
    await screen.findByText("This deployment does not offer an audit log yet.");
  });
});

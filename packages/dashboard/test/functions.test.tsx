import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard, type FunctionInfo } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ValidatorCode } from "../src/functions/screen.tsx";
import { buildFunctionTree, describeFunction, splitPath } from "../src/functions/tree.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const mockSource = () => new MockDataSource({ seed: 7, now: NOW, executions: 60, logIntervalMs: 3_600_000 });

function mount(path = "/functions", source = mockSource()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source} history={history} />);
  return { history, source };
}
const nav = () => screen.getByRole("navigation", { name: "Functions" });

beforeEach(() => localStorage.clear());

const fn = (path: string, kind: FunctionInfo["kind"] = "query"): FunctionInfo => ({
  path,
  kind,
  visibility: "public",
});

const checkedTypes = () =>
  ["success", "failure", "debug", "info", "warn", "error"].filter(
    (name) => screen.getByRole("checkbox", { name }).getAttribute("aria-checked") === "true",
  );

describe("the function tree", () => {
  test("folders from module paths, before files; everything alphabetical", () => {
    const tree = buildFunctionTree([
      fn("tasks:list"),
      fn("admin/users:get"),
      fn("admin/audit/log:read"),
      fn("tasks:add"),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["admin", "tasks"]);
    const admin = tree[0]!;
    if (admin.kind !== "folder") throw new Error("admin is a folder");
    expect(admin.children.map((n) => `${n.kind} ${n.name}`)).toEqual(["folder audit", "file users"]);
    const tasks = tree[1]!;
    if (tasks.kind !== "file") throw new Error("tasks is a file");
    expect(tasks.functions.map((f) => f.path)).toEqual(["tasks:add", "tasks:list"]);
  });

  test("paths and descriptions", () => {
    expect(splitPath("a/b:c")).toEqual({ module: "a/b", name: "c" });
    expect(splitPath("a/b")).toEqual({ module: "a/b", name: "default" });
    expect(describeFunction({ path: "x:y", kind: "mutation", visibility: "internal" })).toBe("Internal mutation");
    expect(describeFunction(fn("x:y", "action"))).toBe("Action");
  });
});

describe("the Functions screen", () => {
  test("the modules as a tree; nothing open says what to do", async () => {
    mount();
    await screen.findByRole("heading", { level: 1, name: "Functions" });
    expect(screen.getByText("Pick a function on the left to see its details and its logs.")).toBeDefined();
    const files = within(nav()).getAllByRole("button");
    expect(files.map((b) => b.textContent)).toEqual(["messages", "tasks", "users"]);
    expect(within(nav()).getAllByRole("link").length).toBe(11);
    await userEvent.setup().click(files[1]!);
    expect(files[1]!.getAttribute("aria-expanded")).toBe("false");
    expect(within(nav()).getAllByRole("link").length).toBe(6);
    await expectAccessible();
  });

  test("a function opens in the URL with its kind, path and only its logs", async () => {
    const { history } = mount();
    await screen.findByRole("heading", { level: 1, name: "Functions" });
    await userEvent.setup().click(within(nav()).getByRole("link", { name: /syncFromAuth/ }));
    await screen.findByRole("heading", { level: 1, name: "syncFromAuth" });
    expect(history.location.search).toContain("function=users%3AsyncFromAuth");
    expect(screen.getByText(/Internal action in/)).toBeDefined();
    // Statistics first, as Convex; the logs are the other tab
    expect(screen.getByRole("tab", { name: "Statistics" }).getAttribute("aria-selected")).toBe("true");
    await userEvent.setup().click(screen.getByRole("tab", { name: "Logs" }));
    expect(history.location.search).toContain("tab=logs");
    const grid = screen.getByRole("grid", { name: "Log lines of users:syncFromAuth" });
    await waitFor(() => expect(within(grid).getAllByRole("row").length).toBeGreaterThan(1));
    const fns = within(grid)
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("gridcell")[2]!.textContent);
    expect(new Set(fns)).toEqual(new Set(["Ausers:syncFromAuth"]));
    // one function: its filter column has the time range and the types, no functions or kinds (UI-01 §22.4)
    const filters = screen.getByRole("navigation", { name: "Log filters" });
    expect(within(filters).getByRole("region", { name: "Time range" })).toBeDefined();
    expect(within(filters).getByRole("region", { name: "Type" })).toBeDefined();
    expect(within(filters).queryByRole("region", { name: "Functions" })).toBeNull();
    expect(within(filters).queryByRole("region", { name: "Function kind" })).toBeNull();
    expect(screen.getByRole("application", { name: "Log lines per time bucket" })).toBeDefined();
    await expectAccessible();
  });

  test("search narrows the tree; an unknown function in the URL says so", async () => {
    mount("/functions?function=nope:gone");
    await screen.findByText("There is no function nope:gone. Pick one on the left.");
    const user = userEvent.setup();
    await user.click(within(nav()).getByRole("button", { name: "tasks" })); // collapsed: searching opens it
    await user.type(screen.getByRole("searchbox", { name: "Search functions" }), "LIST");
    const links = within(nav()).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/functions?function=messages%3Alist",
      "/functions?function=tasks%3Alist",
    ]);
    expect(within(nav()).getAllByRole("link", { name: "list , query" }).length).toBe(2);
  });

  test("a function shows its declared validators as code, or says it declares none", async () => {
    mount("/functions?function=tasks:byOwner&tab=logs");
    await screen.findByRole("heading", { level: 1, name: "byOwner" });
    const args = screen.getByRole("region", { name: "Arguments validator" });
    expect(args.querySelector("pre")?.textContent).toBe('v.object({ owner: v.id("users") })');
    const returns = screen.getByRole("region", { name: "Returns validator" }).querySelector("pre")?.textContent;
    expect(returns).toStartWith("v.array(v.object({\n");
    await expectAccessible();
    cleanup();
    mount("/functions?function=tasks:summarize&tab=logs");
    await screen.findByRole("heading", { level: 1, name: "summarize" });
    expect(screen.getByText("None declared: any arguments are accepted.")).toBeDefined();
  });

  test("a function's log filters are its own", async () => {
    mount("/functions?function=tasks:list&tab=logs");
    await screen.findByRole("heading", { level: 1, name: "list" });
    await userEvent.setup().type(screen.getByRole("searchbox", { name: "Search logs" }), "ran");
    await waitFor(() => expect(localStorage.getItem("bunvex:function-logs:default:tasks:list")).toContain("ran"));
    expect(localStorage.getItem("bunvex:logs:default")).toBeNull();
  });

  test("its log filters are in the URL too: a link opens filtered, each function restores its own", async () => {
    const source = mockSource();
    const { history } = mount("/functions?function=tasks:list&type=failure&q=ran", source);
    await screen.findByRole("heading", { level: 1, name: "list" });
    expect(checkedTypes()).toEqual(["failure"]);
    expect((screen.getByRole("searchbox", { name: "Search logs" }) as HTMLInputElement).value).toBe("ran");
    // another function opens with its own (none), then tasks:list comes back with the kept view in the URL
    act(() => history.push("/functions?function=tasks:create&tab=logs"));
    await screen.findByRole("heading", { level: 1, name: "create" });
    expect(checkedTypes()).toHaveLength(6);
    cleanup();
    const again = mount("/functions?function=tasks:list", source);
    await screen.findByRole("heading", { level: 1, name: "list" });
    await waitFor(() =>
      expect(Object.fromEntries(new URLSearchParams(again.history.location.search))).toEqual({
        function: "tasks:list",
        type: "failure",
        q: "ran",
        tab: "statistics", // the kept filters come back without leaving the tab it opened on
      }),
    );
  });

  test("an unknown type in the URL is dropped", async () => {
    const { history } = mount("/functions?function=tasks:list&type=loud&tab=logs");
    await screen.findByRole("heading", { level: 1, name: "list" });
    expect(checkedTypes()).toHaveLength(6);
    expect(history.location.search).toBe("?function=tasks%3Alist&tab=logs");
  });

  test("picking a type keeps the open function in the URL; Back undoes it", async () => {
    const { history } = mount("/functions?function=tasks:list&tab=logs");
    await screen.findByRole("heading", { level: 1, name: "list" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "debug" }));
    const params = () => Object.fromEntries(new URLSearchParams(history.location.search));
    await waitFor(() =>
      expect(params()).toEqual({ function: "tasks:list", type: "success,failure,info,warn,error", tab: "logs" }),
    );
    act(() => history.back());
    await waitFor(() => expect(params()).toEqual({ function: "tasks:list", tab: "logs" }));
    await waitFor(() => expect(checkedTypes()).toHaveLength(6));
  });

  test("a long validator scrolls past 12 lines and says so; a short one does not (UX-13)", () => {
    const long = Array.from({ length: 20 }, (_, i) => `  f${i}: v.string(),`).join("\n");
    const { unmount } = render(<ValidatorCode code={`v.object({\n${long}\n})`} />);
    expect(screen.getByText("22 lines: scroll for the rest.")).toBeDefined();
    unmount();
    render(<ValidatorCode code="v.object({ a: v.string() })" />);
    expect(screen.queryByText(/scroll for the rest/)).toBeNull();
  });
});

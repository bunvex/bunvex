import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard, DataSourceError, type ValidatorJson } from "@bunvex/dashboard";
import { MockDataSource, type MockDataSourceOptions } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseArgs } from "../src/runner/runner.tsx";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const mockSource = (opts: Partial<MockDataSourceOptions> = {}) =>
  new MockDataSource({ seed: 7, now: NOW, executions: 20, logIntervalMs: 3_600_000, ...opts });

function mount(path: string, source = mockSource()) {
  render(<Dashboard dataSource={source} history={createMemoryHistory({ initialEntries: [path] })} />);
  return source;
}
const runner = () => screen.getByRole("region", { name: "Run a function" });
const args = () => within(runner()).getByRole("textbox", { name: "Arguments" });

beforeEach(() => localStorage.clear());

describe("arguments", () => {
  test("one object literal; empty is {}", () => {
    expect(parseArgs("")).toEqual({ ok: true, args: {} });
    expect(parseArgs("{ limit: 2, owner: 'x' }")).toEqual({ ok: true, args: { limit: 2, owner: "x" } });
    expect(parseArgs("[1]")).toMatchObject({ ok: false, offset: 0 });
    expect(parseArgs("{ limit: }").ok).toBe(false);
  });

  test("checked against a validator, the first misfit points at its place", () => {
    const v: ValidatorJson = {
      type: "object",
      value: {
        limit: { fieldType: { type: "number" }, optional: true },
        owner: { fieldType: { type: "id", tableName: "users" }, optional: false },
      },
    };
    expect(parseArgs("{ owner: 'x' }", v)).toEqual({ ok: true, args: { owner: "x" } });
    expect(parseArgs("{ owner: 'x', limit: 'a' }", v)).toMatchObject({ ok: false, offset: 21 }); // the value
    expect(parseArgs("{ owner: 'x', nope: 1 }", v)).toMatchObject({ ok: false, offset: 14 }); // the key
    expect(parseArgs("{ limit: 1 }", v)).toMatchObject({ ok: false, offset: 0 }); // the object missing it
    // every misfit has its place; the first is the message
    expect(parseArgs("{ owner: 1, limit: 'a' }", v)).toMatchObject({
      ok: false,
      offset: 9,
      more: [{ message: "limit: Type 'string' is not assignable to v.float64()", offset: 19 }],
    });
  });
});

describe("the function runner", () => {
  test("Run on a function opens the runner on it; a query's value and log lines show, and the run is logged", async () => {
    mount("/functions?function=tasks:list");
    await screen.findByRole("heading", { level: 1, name: "list" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(within(runner()).getByText("Query")).toBeDefined();
    fireEvent.change(args(), { target: { value: "{ limit: 2 }" } });
    await user.click(within(runner()).getByRole("button", { name: "Run query" }));
    await within(runner()).findByText(/^Succeeded in \d+ ms$/);
    const result = within(runner()).getByText(/_id: "/, { selector: "pre" }).textContent!;
    expect(result.match(/_id:/g)?.length).toBe(2);
    expect(within(runner()).getByRole("heading", { name: "Logs" })).toBeDefined();
    const grid = screen.getByRole("grid", { name: "Log lines of tasks:list" });
    await waitFor(() =>
      expect(within(within(grid).getAllByRole("row")[1]!).getAllByRole("gridcell")[2]!.textContent).toMatch(/^success/),
    );
    await expectAccessible();
  });

  test("Ctrl+` shows and hides it anywhere; the header button too", async () => {
    mount("/");
    await screen.findByRole("heading", { level: 1, name: "Health" });
    const user = userEvent.setup();
    await user.keyboard("{Control>}`{/Control}");
    expect(runner()).toBeDefined();
    await user.keyboard("{Control>}`{/Control}");
    expect(screen.queryByRole("region", { name: "Run a function" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Run functions" }));
    expect(runner()).toBeDefined();
    await user.click(within(runner()).getByRole("button", { name: "Close the runner" }));
    expect(screen.queryByRole("region", { name: "Run a function" })).toBeNull();
  });

  test("arguments that do not parse say why and cannot run; a thrown error is the result", async () => {
    mount("/functions?function=users:get");
    await screen.findByRole("heading", { level: 1, name: "get" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.change(args(), { target: { value: "{ id: }" } });
    expect(within(runner()).getByText(`Unexpected "}"`)).toBeDefined();
    expect(within(runner()).getByRole("button", { name: "Run query" }).hasAttribute("disabled")).toBe(true);
  });

  test("a declared arguments validator gives the template and checks what is typed; Run waits for a fit", async () => {
    mount("/functions?function=tasks:byOwner");
    await screen.findByRole("heading", { level: 1, name: "byOwner" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect((args() as HTMLTextAreaElement).value).toBe('{\n  owner: "",\n}');
    const run = () => within(runner()).getByRole("button", { name: "Run query" });
    for (const [text, message] of [
      ["{}", `Property 'owner' is missing but required: v.id("users")`],
      ["{ owner: 1 }", `owner: Type 'number' is not assignable to v.id("users")`],
      ["{ owner: 'x', extra: 1 }", `Property 'extra' does not exist in v.object({ owner: v.id("users") })`],
    ] as const) {
      fireEvent.change(args(), { target: { value: text } });
      expect(within(runner()).getByText(message)).toBeDefined();
      expect(run().hasAttribute("disabled")).toBe(true);
    }
    fireEvent.change(args(), { target: { value: "{ owner: 'x' }" } });
    expect(run().hasAttribute("disabled")).toBe(false);
  });

  test("the source checks the arguments too: a misfit is the run's error; a thrown error is the result", async () => {
    const source = mockSource();
    const bad = await source.runFunction("users:get", { id: 1 });
    expect(bad.error?.message).toBe(`ArgumentValidationError: id: Type 'number' is not assignable to v.id("users")`);
    mount("/functions?function=tasks:summarize", source); // declares no validator: anything goes
    await screen.findByRole("heading", { level: 1, name: "summarize" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect((args() as HTMLTextAreaElement).value).toBe("{}");
    fireEvent.change(args(), { target: { value: "{ throw: 'no such user' }" } });
    await user.click(within(runner()).getByRole("button", { name: "Run action" }));
    await within(runner()).findByText(/^Failed in/);
    expect(within(runner()).getByText("Uncaught Error: no such user", { selector: "pre" })).toBeDefined();
  });

  test("a read-only credential runs queries only; a refused call is said", async () => {
    const source = mockSource({
      capabilities: { operations: ["viewData", "viewLogs", "runFunctions"], readOnly: true },
    });
    mount("/functions?function=tasks:create", source);
    await screen.findByRole("heading", { level: 1, name: "create" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(within(runner()).getByText("A read-only credential runs queries only.")).toBeDefined();
    expect(within(runner()).getByRole("button", { name: "Run mutation" }).hasAttribute("disabled")).toBe(true);
    source.runFunction = () => Promise.reject(new DataSourceError("unavailable", "connection refused"));
    await user.click(within(runner()).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "tasks:list" }));
    await user.click(within(runner()).getByRole("button", { name: "Run query" }));
    expect((await within(runner()).findByRole("alert")).textContent).toBe("connection refused");
  });

  test("no runner where the source cannot run functions, or the credential may not", async () => {
    const without = mockSource({ capabilities: { operations: ["viewData", "viewLogs"], readOnly: false } });
    mount("/functions?function=tasks:list", without);
    await screen.findByRole("heading", { level: 1, name: "list" });
    expect(screen.queryByRole("button", { name: "Run functions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    await userEvent.setup().keyboard("{Control>}`{/Control}");
    expect(screen.queryByRole("region", { name: "Run a function" })).toBeNull();
  });
});

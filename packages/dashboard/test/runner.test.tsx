import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard, DataSourceError, type ValidatorJson } from "@bunvex/dashboard";
import { MockDataSource, type MockDataSourceOptions } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appendRunHistory, RUN_HISTORY_LENGTH, readRunHistory } from "../src/runner/history.ts";
import { parseIdentity } from "../src/runner/identity.ts";
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
/** Turns "Act as a user" on — it is one setting for the whole page, as in Convex, so it may be on already. */
async function actAs(user: ReturnType<typeof userEvent.setup>) {
  const box = within(runner()).getByRole("checkbox", { name: "Act as a user" });
  if (box.getAttribute("aria-checked") !== "true") await user.click(box);
}
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
  test("Run on a function opens the runner on it; a query is subscribed: its value and log lines show, it is logged, and it updates", async () => {
    const source = mount("/functions?function=tasks:list");
    await screen.findByRole("heading", { level: 1, name: "list" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run" }));
    // the runner is its own chunk: it shows once loaded
    expect(within(await screen.findByRole("region", { name: "Run a function" })).getByText("Query")).toBeDefined();
    // no Run button for a watched query: it follows its arguments, as in Convex
    expect(within(runner()).queryByRole("button", { name: "Run query" })).toBeNull();
    expect(within(runner()).getByText("Subscribed: the result updates as the data changes.")).toBeDefined();
    fireEvent.change(args(), { target: { value: "{ limit: 2 }" } });
    const result = () => within(runner()).getByText(/_id: "/, { selector: "pre" }).textContent!;
    await waitFor(() => expect(result().match(/_id:/g)?.length).toBe(2));
    expect(within(runner()).getByText(/^Succeeded in \d+ ms$/)).toBeDefined();
    const [added] = await source.insertDocuments("tasks", [{ text: "live", done: false }]);
    await waitFor(() => expect(result()).toContain(added!)); // the newest task, without running it again
    expect(within(runner()).getByRole("heading", { name: "Logs" })).toBeDefined();
    const grid = screen.getByRole("grid", { name: "Log lines of tasks:list" });
    await waitFor(() =>
      expect(within(within(grid).getAllByRole("row")[1]!).getAllByRole("gridcell")[2]!.textContent).toMatch(/^Success/),
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
    expect(within(runner()).getByText(/^Unexpected "}"/).textContent).toContain(
      "The result is paused until the arguments are fixed.",
    );
  });

  test("a declared arguments validator gives the template and checks what is typed; Run waits for a fit", async () => {
    mount("/functions?function=tasks:byOwner");
    await screen.findByRole("heading", { level: 1, name: "byOwner" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect((args() as HTMLTextAreaElement).value).toBe('{\n  owner: "",\n}');
    const paused = () => within(runner()).queryByText(/paused until the arguments are fixed/);
    for (const [text, message] of [
      ["{}", `Property 'owner' is missing but required: v.id("users")`],
      ["{ owner: 1 }", `owner: Type 'number' is not assignable to v.id("users")`],
      ["{ owner: 'x', extra: 1 }", `Property 'extra' does not exist in v.object({ owner: v.id("users") })`],
    ] as const) {
      fireEvent.change(args(), { target: { value: text } });
      expect(within(runner()).getByText(message, { exact: false })).toBeDefined();
      expect(paused()).not.toBeNull();
    }
    fireEvent.change(args(), { target: { value: "{ owner: 'x' }" } });
    expect(paused()).toBeNull();
    expect(within(runner()).getByText("Subscribed: the result updates as the data changes.")).toBeDefined();
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
    source.watchFunction = (_path, _args, _onResult, onError) => {
      setTimeout(() => onError(new DataSourceError("unavailable", "connection refused")), 0);
      return () => {};
    };
    await user.click(within(runner()).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "tasks:list" }));
    expect((await within(runner()).findByRole("alert")).textContent).toBe("connection refused");
  });

  test("without watchFunction, a query is run once with Run, as a mutation is", async () => {
    const source = mockSource();
    (source as { watchFunction?: unknown }).watchFunction = undefined;
    mount("/functions?function=tasks:list", source);
    await screen.findByRole("heading", { level: 1, name: "list" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(within(runner()).queryByText(/^Subscribed/)).toBeNull();
    await user.click(within(runner()).getByRole("button", { name: "Run query" }));
    await within(runner()).findByText(/^Succeeded in \d+ ms$/);
    // run, not watched — and still no history: a query keeps none, as in Convex
    expect(within(runner()).queryByRole("button", { name: "Previous arguments" })).toBeNull();
    expect(readRunHistory("default", "tasks:list")).toEqual([]);
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

  test("a mutation's or action's past arguments: Previous / Next fill the editor; kept in this browser", async () => {
    mount("/functions?function=tasks:summarize");
    await screen.findByRole("heading", { level: 1, name: "summarize" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByRole("region", { name: "Run a function" }); // its own chunk
    expect(within(runner()).queryByRole("button", { name: "Previous arguments" })).toBeNull();
    for (const text of ["{ n: 1 }", "{ n: 2 }", "{ n: 2 }"]) {
      fireEvent.change(args(), { target: { value: text } });
      await user.click(within(runner()).getByRole("button", { name: "Run action" }));
      await within(runner()).findByText(/^(Succeeded|Failed) in/);
    }
    const previous = within(runner()).getByRole("button", { name: "Previous arguments" });
    const next = within(runner()).getByRole("button", { name: "Next arguments" });
    expect(next.hasAttribute("disabled")).toBe(true);
    await user.click(previous); // the same arguments twice in a row are one entry
    expect((args() as HTMLTextAreaElement).value).toBe("{\n  n: 1,\n}");
    expect(previous.hasAttribute("disabled")).toBe(true);
    await user.click(next);
    expect((args() as HTMLTextAreaElement).value).toBe("{\n  n: 2,\n}");
    expect(readRunHistory("default", "tasks:summarize").map((e) => e.args)).toEqual([{ n: 2 }, { n: 1 }]);
  });

  test("the history keeps the last 25 runs; a query has none", async () => {
    for (let n = 0; n < 30; n++) appendRunHistory("s", "m:f", { args: { n }, startedAt: n });
    const kept = readRunHistory("s", "m:f");
    expect(kept.length).toBe(RUN_HISTORY_LENGTH);
    expect(kept[0]!.args).toEqual({ n: 29 });
    mount("/functions?function=tasks:list");
    await screen.findByRole("heading", { level: 1, name: "list" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Run" }));
    expect(within(runner()).queryByRole("button", { name: "Previous arguments" })).toBeNull();
  });

  test("an identity: subject and issuer required, claims typed, customClaims flattened", () => {
    expect(
      parseIdentity("{ subject: 'u1', issuer: 'https://auth', name: 'Ada', customClaims: { role: 'admin' } }"),
    ).toEqual({
      ok: true,
      identity: { subject: "u1", issuer: "https://auth", name: "Ada", role: "admin" },
    });
    expect(parseIdentity("{ subject: 'u1' }")).toMatchObject({
      ok: false,
      error: 'The identity needs "issuer", as text.',
    });
    expect(parseIdentity("{ subject: 'u', issuer: 'i', emailVerified: 'yes' }")).toMatchObject({
      ok: false,
      error: '"emailVerified" is true or false.',
    });
    expect(parseIdentity("[1]").ok).toBe(false);
  });

  test("Act as a user: the run carries the identity, the history keeps it, an invalid one blocks the run", async () => {
    mount("/functions?function=tasks:summarize");
    await screen.findByRole("heading", { level: 1, name: "summarize" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByRole("region", { name: "Run a function" }); // its own chunk
    await actAs(user);
    const who = within(runner()).getByRole("textbox", { name: "User identity" }) as HTMLTextAreaElement;
    expect(who.value).toBe('{\n  subject: "fake_id",\n  issuer: "fake_issuer",\n}'); // Convex's default
    fireEvent.change(who, { target: { value: "{ subject: 'u1' }" } });
    expect(within(runner()).getByText('The identity needs "issuer", as text.')).toBeDefined();
    expect(within(runner()).getByRole("button", { name: "Run action" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(who, { target: { value: "{ subject: 'u1', issuer: 'https://auth', name: 'Ada' }" } });
    await user.click(within(runner()).getByRole("button", { name: "Run action" }));
    await within(runner()).findByText("authenticated as Ada (https://auth)");
    expect(readRunHistory("default", "tasks:summarize")[0]?.identity).toEqual({
      subject: "u1",
      issuer: "https://auth",
      name: "Ada",
    });
    await expectAccessible();
  });

  test("a watched query runs as the user too; a credential without actAsUser cannot", async () => {
    mount("/functions?function=tasks:list");
    await screen.findByRole("heading", { level: 1, name: "list" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByRole("region", { name: "Run a function" }); // its own chunk
    await actAs(user);
    fireEvent.change(within(runner()).getByRole("textbox", { name: "User identity" }), {
      target: { value: "{ subject: 'q1', issuer: 'https://auth' }" },
    });
    await within(runner()).findByText("authenticated as q1 (https://auth)");
    cleanup();
    const limited = mockSource({
      capabilities: { operations: ["viewData", "viewLogs", "runFunctions"], readOnly: false },
    });
    await expect(
      limited.runFunction("tasks:list", {}, { identity: { subject: "u", issuer: "i" } }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    mount("/functions?function=tasks:list", limited);
    await screen.findByRole("heading", { level: 1, name: "list" });
    await user.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByRole("region", { name: "Run a function" });
    const box = within(runner()).getByRole("checkbox", { name: "Act as a user" });
    expect(
      box.getAttribute("aria-disabled") === "true" || box.hasAttribute("disabled") || box.hasAttribute("data-disabled"),
    ).toBe(true);
    expect(within(runner()).getByText("This credential cannot act as a user.")).toBeDefined();
  });

  test("the header's Run functions opens the runner on the function the Functions screen shows (UX-3)", async () => {
    mount("/functions?function=tasks:create");
    await screen.findByRole("heading", { level: 1, name: "create" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Run functions" }));
    await screen.findByRole("region", { name: "Run a function" }); // its own chunk
    expect(within(runner()).getByRole("combobox").textContent).toContain("tasks:create");
  });
});

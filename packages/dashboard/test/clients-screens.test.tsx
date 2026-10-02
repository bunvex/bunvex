// Who the clients are, on Logs, Functions → Statistics and Settings → Apps (UI-01 §33.2).
import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard, type LogEntry } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PLATFORM_LABEL } from "../src/clients/names.ts";
import {
  ALL_LOGS,
  facetCounts,
  matchesLogView,
  searchFromView,
  validateLogsSearch,
  viewFromSearch,
} from "../src/logs/log-filter.ts";
import { clientFor } from "../src/mock/clients.ts";
import { setupSnippet } from "../src/settings/apps.tsx";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
let history: ReturnType<typeof createMemoryHistory>;
function mount(path: string, source = new MockDataSource({ seed: 7, now: Date.now(), executions: 120 })) {
  history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source} history={history} />);
  return source;
}
const params = () => Object.fromEntries(new URLSearchParams(history.location.search));

beforeEach(() => localStorage.clear());

const ios = clientFor(0).platform === "ios" ? clientFor(0) : undefined;
const line = (over: Partial<LogEntry>): LogEntry => ({
  id: "1",
  time: 1_000,
  level: "info",
  message: "m",
  function: { path: "tasks:create", kind: "mutation" },
  ...over,
});

describe("a log line's client", () => {
  const web = line({
    client: { platform: "web", sdk: { name: "@bunvex/client", version: "0.4.2" }, app: { version: "2.3.1" } },
  });
  const phone = line({
    id: "2",
    client: { platform: "ios", sdk: { name: "bunvex-swift", version: "0.2.3" }, app: { version: "2.2.0" } },
  });
  const cron = line({ id: "3" });

  test("filtered by platform and app version; a line no client made is out once either is chosen", () => {
    const v = { ...ALL_LOGS, platforms: ["ios" as const] };
    expect([web, phone, cron].filter((e) => matchesLogView(e, v)).map((e) => e.id)).toEqual(["2"]);
    const byVersion = { ...ALL_LOGS, appVersions: ["2.3.1"] };
    expect([web, phone, cron].filter((e) => matchesLogView(e, byVersion)).map((e) => e.id)).toEqual(["1"]);
    expect([web, phone, cron].every((e) => matchesLogView(e, ALL_LOGS))).toBe(true);
  });

  test("counted per platform and version; in the URL as `platform` and `appVersion`, unknown platforms dropped", () => {
    const c = facetCounts([web, phone, cron, web], ALL_LOGS);
    expect([...c.platforms]).toEqual([
      ["web", 2],
      ["ios", 1],
    ]);
    expect(c.appVersions.get("2.3.1")).toBe(2);
    const v = { ...ALL_LOGS, platforms: ["ios" as const, "web" as const], appVersions: ["2.3.1"] };
    expect(searchFromView(v)).toEqual({ platform: "ios,web", appVersion: "2.3.1" });
    expect(viewFromSearch(validateLogsSearch(searchFromView(v)))).toEqual(v);
    expect(validateLogsSearch({ platform: "ios,toaster" }).platform).toBe("ios");
    // a view that never chose a client reads as it always did
    expect(viewFromSearch(validateLogsSearch({ q: "x" }))).toEqual({ ...ALL_LOGS, text: "x" });
  });

  test("the mock: users' calls carry a client, picked the same way every time", () => {
    expect(clientFor(41)).toEqual(clientFor(41));
    const platforms = new Set(Array.from({ length: 400 }, (_, i) => clientFor(i).platform));
    expect([...platforms].sort()).toEqual(["android", "bun", "expo", "ios", "node", "web"]);
    expect(ios === undefined || ios.sdk.name === "bunvex-swift").toBe(true);
  });

  test("on the Logs screen: a Platform facet, and the client in a line's details", async () => {
    const source = mount("/logs");
    await screen.findByRole("heading", { level: 1, name: "Logs" });
    const filters = screen.getByRole("navigation", { name: "Log filters" });
    const facet = await within(filters).findByRole("region", { name: "Platform" });
    expect(within(facet).getByRole("checkbox", { name: "iOS" })).toBeDefined();
    within(filters).getByRole("region", { name: "App version" });
    const user = userEvent.setup();
    await user.click(within(facet).getByRole("button", { name: "Only ios" }));
    await waitFor(() => expect(params().platform).toBe("ios"));
    const grid = screen.getByRole("grid", { name: "Log lines" });
    await user.click(within(within(grid).getAllByRole("row")[1]!).getAllByRole("gridcell")[5]!);
    const panel = await screen.findByRole("complementary");
    const client = within(panel).getByTestId("log-client");
    // named by the registry: com.acme.shop on iOS is "Shop iOS"
    expect(client.textContent).toMatch(/iOS .*· Shop iOS \d/);
    expect(client.textContent).toContain("bunvex-swift");
    expect((await source.listClientApps()).some((a) => a.name === "Shop iOS")).toBe(true);
    await expectAccessible();
  });
});

describe("a function's calls by platform", () => {
  test("the mock adds them up to the function's calls; calls no client made are counted apart", async () => {
    const source = new MockDataSource({ seed: 7, now: NOW, executions: 300, logIntervalMs: 3_600_000 });
    // the whole history, so some calls no client made fail too
    const w = { start: 0, end: NOW + 1, numBuckets: 1000 };
    const fns = await source.listFunctions();
    let seen = 0;
    for (const f of fns) {
      const by = await source.functionClients(f.path, w);
      const calls = (await source.functionRate(f.path, "invocations", w)).reduce((a, b) => a + (b.value ?? 0), 0);
      const errors = (await source.functionRate(f.path, "errors", w)).reduce((a, b) => a + (b.value ?? 0), 0);
      expect(by.byPlatform.reduce((a, p) => a + p.calls, 0) + by.withoutClient.calls).toBe(calls);
      expect(by.byPlatform.reduce((a, p) => a + p.errors, 0) + by.withoutClient.errors).toBe(errors);
      const counts = by.byPlatform.map((p) => p.calls);
      expect(counts).toEqual([...counts].sort((a, b) => b - a));
      seen += by.byPlatform.length;
    }
    expect(seen).toBeGreaterThan(0);
    const all = await Promise.all(fns.map((f) => source.functionClients(f.path, w)));
    expect(all.some((b) => b.withoutClient.errors > 0)).toBe(true);
  });

  test("on the Statistics tab: one row per platform, with its errors", async () => {
    mount("/functions?function=tasks:list");
    const panel = await screen.findByRole("tabpanel", { name: "Statistics" });
    const card = await within(panel).findByRole("region", { name: "By platform" });
    const table = await within(card).findByRole("table", { name: "Calls and errors by platform" });
    const heads = within(table)
      .getAllByRole("rowheader")
      .map((h) => h.textContent);
    expect(heads.length).toBeGreaterThan(0);
    for (const h of heads) expect(Object.values(PLATFORM_LABEL)).toContain(h!);
    await expectAccessible();
  });
});

describe("Settings → Apps", () => {
  const apps = () => screen.findByRole("list", { name: "Apps" });

  test("the registered apps, with the versions their clients reported and when one last connected", async () => {
    mount("/settings/apps");
    const list = await apps();
    const rows = within(list).getAllByTestId("client-app");
    expect(rows.map((r) => r.querySelector(".font-medium")?.textContent)).toEqual([
      "Shop Web",
      "Shop iOS",
      "Shop Android",
    ]);
    const versions = within(rows[1]!).getByRole("list", { name: "Shop iOS versions seen" });
    expect(within(versions).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(rows[1]!.textContent).toContain("com.acme.shop");
    expect(rows[1]!.textContent).toMatch(/Last seen.*ago|now/);
    await expectAccessible();
  });

  test("register, change and remove; dropping an identifier and removing are confirmed", async () => {
    const source = mount("/settings/apps");
    await apps();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Register an app" }));
    const form = screen.getByRole("form", { name: "Register an app" });
    expect((within(form).getByRole("button", { name: "Register" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(form).getByLabelText("Name"), "Staff");
    await user.type(within(form).getByLabelText("Identifiers"), "com.acme.staff{Enter}com.acme.staff.beta");
    await user.click(within(form).getByRole("button", { name: "Register" }));
    await screen.findByText("Registered Staff.");
    let made = (await source.listClientApps()).find((a) => a.name === "Staff")!;
    expect(made.identifiers).toEqual(["com.acme.staff", "com.acme.staff.beta"]);

    // dropping an identifier: the clients it named lose the name, so it asks first
    await user.click(screen.getByRole("button", { name: "Edit Staff" }));
    const edit = screen.getByRole("form", { name: "Edit Staff" });
    const ids = within(edit).getByLabelText("Identifiers");
    await user.clear(ids);
    await user.type(ids, "com.acme.staff");
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("com.acme.staff.beta will no longer be named Staff");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await screen.findByText("Saved Staff.");
    made = (await source.listClientApps()).find((a) => a.name === "Staff")!;
    expect(made.identifiers).toEqual(["com.acme.staff"]);

    const row = (await apps()).querySelectorAll("[data-testid=client-app]");
    const staff = [...row].find((r) => r.textContent?.includes("Staff"))! as HTMLElement;
    await user.click(within(staff).getByRole("button", { name: "Remove" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Keep it" }));
    expect((await source.listClientApps()).some((a) => a.name === "Staff")).toBe(true);
    await user.click(within(staff).getByRole("button", { name: "Remove" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove app" }));
    await screen.findByText("Removed Staff.");
    expect((await source.listClientApps()).some((a) => a.name === "Staff")).toBe(false);
    // and the History screen has all three
    const events = await source.listAuditEvents({ numItems: 10, cursor: null });
    expect(events.page.map((e) => e.action).slice(0, 3)).toEqual([
      "delete_client_app",
      "update_client_app",
      "create_client_app",
    ]);
  });

  test("read-only: the list, without its actions", async () => {
    mount(
      "/settings/apps",
      new MockDataSource({
        seed: 7,
        now: Date.now(),
        executions: 5,
        capabilities: { operations: ["viewData", "viewMetrics", "writeData"], readOnly: true },
      }),
    );
    await apps();
    expect(screen.queryByRole("button", { name: "Register an app" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
  });

  test("the setup snippet: each platform's language, marked as the planned API", async () => {
    expect(setupSnippet("ios", "com.acme.shop")).toContain('id: "com.acme.shop"');
    expect(setupSnippet("ios")).toContain("Bundle.main.bundleIdentifier");
    expect(setupSnippet("android")).toContain("BuildConfig.APPLICATION_ID");
    expect(setupSnippet("web")).toContain('from "@bunvex/client"');
    expect(setupSnippet("web")).not.toContain("id:");
    expect(setupSnippet("expo", "com.acme.staff")).toContain('id: "com.acme.staff"');
    for (const p of ["web", "ios", "android", "node"] as const) expect(setupSnippet(p)).not.toMatch(/convex/i);
    mount("/settings/apps");
    await apps();
    expect(screen.getByText("Planned API")).toBeDefined();
    expect(screen.getByTestId("app-setup-snippet").textContent).toContain("@bunvex/client");
  });
});

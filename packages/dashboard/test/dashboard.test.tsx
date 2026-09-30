import { describe, expect, test } from "bun:test";
import {
  createDashboardQueryClient,
  Dashboard,
  type DashboardDataSource,
  type DashboardProps,
  DataSourceError,
  type DeploymentStats,
  dashboardKeys,
} from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const SAMPLE: DeploymentStats = {
  at: NOW,
  commitTs: 10,
  commitGroups: 1,
  conflicts: 0,
  retries: 0,
  cacheHits: 0,
  cacheMisses: 0,
  subscriptions: 0,
  subscriptionReruns: 0,
  subscriptionUpdates: 0,
};
const mockSource = () => new MockDataSource({ seed: 2, now: NOW, statsIntervalMs: 5, documents: { tasks: 20 } });

function mount(path = "/", props: Partial<DashboardProps> = {}) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const utils = render(<Dashboard dataSource={mockSource()} history={history} {...props} />);
  return { history, ...utils };
}

const heading = (name: string) => screen.findByRole("heading", { level: 1, name });

describe("navigation", () => {
  test("links navigate in place and mark the current page", async () => {
    mount();
    await heading("Health");
    const nav = screen.getByRole("navigation", { name: "Dashboard" });
    expect(within(nav).getByRole("link", { name: "Health" }).getAttribute("aria-current")).toBe("page");
    const logs = within(nav).getByRole("link", { name: "Logs" });
    expect(logs.getAttribute("href")).toBe("/logs");
    await userEvent.setup().click(logs);
    await heading("Logs");
    expect(logs.getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Health" }).getAttribute("aria-current")).toBeNull();
  });

  test("/database opens the first table, and keeps Database current", async () => {
    const { history } = mount("/database");
    await waitFor(() => expect(history.location.pathname).toBe("/database/imports"));
    await heading("imports");
    expect(screen.getByRole("link", { name: "Database" }).getAttribute("aria-current")).toBe("page");
  });

  test("under a basepath, links and addresses carry it", async () => {
    mount("/projects/p1/dashboard/functions", { basepath: "/projects/p1/dashboard" });
    await heading("Functions");
    expect(screen.getByRole("link", { name: "Logs" }).getAttribute("href")).toBe("/projects/p1/dashboard/logs");
  });

  test("an unknown address says so, inside the shell", async () => {
    mount("/nowhere");
    await heading("Page not found");
    expect(screen.getByRole("navigation", { name: "Dashboard" })).toBeDefined();
  });

  test("a navigation moves focus to the main region; a search-only change does not", async () => {
    const { history } = mount();
    await heading("Health");
    const main = screen.getByRole("main");
    expect(document.activeElement).not.toBe(main); // not on the first load
    await userEvent.setup().click(screen.getByRole("link", { name: "Logs" }));
    await heading("Logs");
    await waitFor(() => expect(document.activeElement).toBe(main));
    (document.activeElement as HTMLElement).blur();
    act(() => history.push("/logs?level=error"));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).not.toBe(main);
    await userEvent.setup().click(screen.getByRole("button", { name: "Skip to content" }));
    expect(document.activeElement).toBe(main);
  });
});

describe("data", () => {
  test("the header shows the deployment and the host's actions", async () => {
    mount("/", { headerActions: <button type="button">Account</button> });
    await screen.findByText("memory");
    expect(screen.getByText("local")).toBeDefined();
    expect(screen.getByRole("button", { name: "Account" })).toBeDefined();
  });

  test("the host's QueryClient holds the dashboard's cache, under its scope", async () => {
    const queryClient = createDashboardQueryClient();
    mount("/", { queryClient, scope: "p1" });
    await screen.findByText("memory");
    expect(queryClient.getQueryData(dashboardKeys.deployment("p1"))).toMatchObject({ persistence: "memory" });
  });

  test("a failing loader shows the error inside the shell, and retry recovers", async () => {
    const base = mockSource();
    let fail = true;
    const source: DashboardDataSource = Object.assign(Object.create(base), {
      listFunctions: (opts?: { signal?: AbortSignal }) =>
        fail ? Promise.reject(new DataSourceError("unavailable", "connection refused")) : base.listFunctions(opts),
    });
    const queryClient = createDashboardQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    render(
      <Dashboard
        dataSource={source}
        history={createMemoryHistory({ initialEntries: ["/functions"] })}
        queryClient={queryClient}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The deployment did not answer");
    expect(screen.getByRole("navigation", { name: "Dashboard" })).toBeDefined();
    fail = false;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    await heading("Functions");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("overview", () => {
  const clockValue = () =>
    within(screen.getByRole("region", { name: "Commit timestamp" })).getByRole("heading", {
      name: "Commit timestamp",
    }).nextElementSibling!.textContent;

  test("shows the live counters, updating from watchStats", async () => {
    mount();
    await screen.findByRole("region", { name: "Commit timestamp" });
    const first = clockValue();
    expect(first).toMatch(/^[\d,]+$/);
    await waitFor(() => expect(clockValue()).not.toBe(first));
    expect(screen.getByText("Query cache hit rate")).toBeDefined();
    await expectAccessible();
  });

  test("the history survives leaving the overview and coming back", async () => {
    mount();
    await screen.findByRole("region", { name: "Commit timestamp" });
    await waitFor(() => expect(screen.getByRole("img").textContent).toMatch(/now/));
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Functions" }));
    await heading("Functions");
    await user.click(screen.getByRole("link", { name: "Health" }));
    // back at once with the samples kept, not "waiting for a second sample"
    expect((await screen.findByRole("img")).textContent).toMatch(/now/);
  });

  test("a failing watcher shows what went wrong, and recovers when data comes back", async () => {
    let push: ((s: DeploymentStats) => void) | undefined;
    let fail: ((e: DataSourceError) => void) | undefined;
    const source: DashboardDataSource = Object.assign(Object.create(mockSource()), {
      watchStats: (onStats: (s: DeploymentStats) => void, onError: (e: DataSourceError) => void) => {
        push = onStats;
        fail = onError;
        return () => {};
      },
    });
    render(<Dashboard dataSource={source} history={createMemoryHistory({ initialEntries: ["/"] })} />);
    await screen.findByLabelText("Loading the deployment's counters");
    act(() => fail!(new DataSourceError("unauthorized", "bad admin key")));
    expect(screen.getByRole("alert").textContent).toContain("Check the admin key");
    act(() => push!(SAMPLE));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("region", { name: "Commit timestamp" })).toBeDefined();
  });
});

// STUDY-149 PR 6: what the screens do with a source's connection (Convex's `DisconnectedOverlay` and its SWR keys
// going null while disconnected) and with `watchTables` (Convex's sidebar following the table mapping).
import { describe, expect, test } from "bun:test";
import { createDashboardQueryClient, Dashboard, type DashboardProps } from "@bunvex/dashboard";
import type { ConnectionStatus } from "@bunvex/dashboard/data-source";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);

/** The mock, with a connection the test drives (the mock itself is always connected). */
function connectedMock() {
  const source = new MockDataSource({ seed: 2, now: NOW, statsIntervalMs: 50 });
  const listeners = new Set<(s: ConnectionStatus) => void>();
  Object.assign(source, {
    watchConnection(onStatus: (s: ConnectionStatus) => void) {
      listeners.add(onStatus);
      return () => listeners.delete(onStatus);
    },
  });
  const set = (s: ConnectionStatus) =>
    act(() => {
      for (const l of listeners) l(s);
    });
  return { source, set, listeners };
}

function mount(source: MockDataSource, path = "/", props: Partial<DashboardProps> = {}) {
  const history = createMemoryHistory({ initialEntries: [path] });
  return render(<Dashboard dataSource={source} history={history} {...props} />);
}

const issue = () => screen.queryByRole("alert", { name: "Connection issue" });

describe("the connection (Convex's disconnect overlay)", () => {
  test("disconnected covers the screens and says where the server should be; connected uncovers them", async () => {
    const { source, set, listeners } = connectedMock();
    const { unmount } = mount(source, "/", { deploymentUrl: "http://127.0.0.1:3210" });
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(listeners.size).toBe(1);
    await set("unknown");
    expect(issue() === null).toBe(true);
    await set("disconnected");
    const alert = await screen.findByRole("alert", { name: "Connection issue" });
    expect(alert.textContent).toContain(
      "Check that your bunvex server is running and accessible at http://127.0.0.1:3210.",
    );
    await expectAccessible(alert);
    // `unknown` again (the socket came back once): as Convex's, the overlay goes until it is settled
    await set("unknown");
    expect(issue() === null).toBe(true);
    await set("disconnected");
    await screen.findByRole("alert", { name: "Connection issue" });
    await set("connected");
    expect(issue() === null).toBe(true);
    unmount();
    expect(listeners.size).toBe(0);
  });

  test("without a host URL the deployment's own is named", async () => {
    const { source, set } = connectedMock();
    mount(source);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const url = (await source.getDeployment()).url;
    await set("disconnected");
    const alert = await screen.findByRole("alert", { name: "Connection issue" });
    expect(alert.textContent).toContain(`accessible at ${url}.`);
  });

  test("the polled reads stop while disconnected and are asked again once connected", async () => {
    const { source, set } = connectedMock();
    let asked = 0;
    const top = source.topFunctions.bind(source);
    source.topFunctions = (...args: Parameters<typeof top>) => {
      asked++;
      return top(...args);
    };
    const queryClient = createDashboardQueryClient();
    mount(source, "/", { queryClient });
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    await waitFor(() => expect(asked).toBeGreaterThan(0));
    await set("disconnected");
    await screen.findByRole("alert", { name: "Connection issue" });
    // whatever would ask again (here every query made stale at once), the metrics wait while disconnected
    const before = asked;
    await act(() => queryClient.invalidateQueries());
    await new Promise((r) => setTimeout(r, 100));
    expect(asked).toBe(before);
    await set("connected");
    // and are asked again as soon as the connection is back, not at their next interval
    await waitFor(() => expect(asked).toBeGreaterThan(before), { timeout: 2000 });
  });

  test("back from a short disconnection, the polled reads ask at once, fresh or not (Convex's SWR key returning)", async () => {
    const { source, set } = connectedMock();
    let asked = 0;
    const top = source.topFunctions.bind(source);
    source.topFunctions = (...args: Parameters<typeof top>) => {
      asked++;
      return top(...args);
    };
    mount(source);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    await waitFor(() => expect(asked).toBeGreaterThan(0));
    const before = asked;
    await set("disconnected");
    await set("connected");
    await waitFor(() => expect(asked).toBeGreaterThan(before), { timeout: 2000 });
  });

  test("a read that failed while away is read again once the connection is back", async () => {
    const { source, set } = connectedMock();
    const real = source.getDeployment.bind(source);
    let failing = true;
    source.getDeployment = (o) => (failing ? Promise.reject(new Error("socket closed")) : real(o));
    mount(source);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    await screen.findAllByText("Deployment unavailable", {}, { timeout: 4000 });
    await set("disconnected");
    failing = false;
    await set("connected");
    await waitFor(() => expect(screen.queryAllByText("Deployment unavailable").length).toBe(0), { timeout: 4000 });
  });
});

describe("the table list, live (Convex's sidebar on the table mapping)", () => {
  test("a table created elsewhere appears in the sidebar; a deleted one goes", async () => {
    const source = new MockDataSource({ seed: 2, now: NOW, liveWritesMs: 0 });
    mount(source, "/database/users");
    await screen.findByRole("heading", { level: 1, name: "users" });
    const sidebar = screen.getByRole("navigation", { name: "Tables" });
    // (booleans: a failed expectation on a happy-dom node would print the whole node)
    expect(within(sidebar).queryByRole("link", { name: /^scratch\b/ }) === null).toBe(true);
    // not through the screen: another client of the deployment
    await source.createTable("scratch");
    await within(sidebar).findByRole("link", { name: /^scratch\b/ });
    await source.deleteTables(["scratch"]);
    await waitFor(() => expect(within(sidebar).queryByRole("link", { name: /^scratch\b/ }) === null).toBe(true));
  });

  test("an empty deployment opens the first table that appears", async () => {
    const source = new MockDataSource({ seed: 2, now: NOW, tables: false });
    mount(source, "/database");
    await screen.findByText("There are no tables here yet.");
    await source.insertDocuments("notes", [{ text: "hi" }]);
    await screen.findByRole("heading", { level: 1, name: "notes" });
  });
});

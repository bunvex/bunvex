// The Subscriptions screen (STUDY-131 AD-25): live queries per session with what they read and why they ran,
// the query cache, a path filter in the URL, following new invalidations, and no data without `viewMetrics`.
import { afterEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import type { ConnectionStatus } from "@bunvex/dashboard/data-source";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describeSubscriptionsContract } from "../src/contract-subscriptions.ts";
import { pollInterval } from "../src/subscriptions/screen.tsx";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 9, 5, 12);
const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 4, now: NOW, executions: 5, invalidationIntervalMs: 20, ...opts });

function mount(path: string, src = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}

afterEach(cleanup);

describe("the contract's subscriptions part, without viewMetrics", () =>
  describeSubscriptionsContract({
    make: () => source({ capabilities: { operations: ["viewData"], readOnly: true } }),
    test,
    watchTimeoutMs: 200,
  }));

describe("the Subscriptions screen", () => {
  test("lists the live queries; one opens with its read set and why it ran", async () => {
    const { history } = mount("/subscriptions");
    await screen.findByRole("heading", { level: 1, name: "Subscriptions" });
    const grid = await screen.findByRole("grid", { name: "Live queries" });
    await waitFor(() => expect(within(grid).getAllByRole("row").length).toBeGreaterThan(3));
    expect(screen.getByText(/live queries in 3 sessions/)).toBeDefined();
    await expectAccessible();
    const user = userEvent.setup();
    await user.click(within(grid).getAllByText("messages:list")[0]!);
    await waitFor(() => expect(history.location.search).toContain("query="));
    const panel = await screen.findByRole("complementary", { name: "Live query" });
    const reads = within(panel).getByRole("region", { name: "Read set" });
    expect(within(reads).getByText("messages.by_channel")).toBeDefined();
    expect(within(reads).getByText('[["general"], ["general", …])')).toBeDefined();
    const why = within(panel).getByRole("region", { name: "Why it ran" });
    const entries = within(why)
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(entries.some((t) => /Commit ts \d+ by messages:send into messages\.by_channel/.test(t))).toBe(true);
    expect(entries.some((t) => t.includes('wrote ["general", '))).toBe(true);
  });

  test("a path filter in the URL keeps only matching queries", async () => {
    mount("/subscriptions?path=users");
    const grid = await screen.findByRole("grid", { name: "Live queries" });
    await waitFor(() => {
      const paths = within(grid)
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("gridcell")[0]!.textContent);
      expect(paths.length).toBeGreaterThan(0);
      expect(new Set(paths)).toEqual(new Set(["users:me"]));
    });
  });

  test("the query cache tab: counters and the biggest entries", async () => {
    mount("/subscriptions?tab=cache");
    const dl = await screen.findByLabelText("Query cache counters");
    expect(within(dl).getByText("Evictions")).toBeDefined();
    expect(within(dl).getByText(/invalidated \d+/)).toBeDefined();
    const grid = await screen.findByRole("grid", { name: "Query cache entries" });
    await waitFor(() => expect(within(grid).getAllByRole("row").length).toBe(5));
  });

  test("follow lists new invalidations as they land", async () => {
    mount("/subscriptions");
    await screen.findByRole("grid", { name: "Live queries" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Follow invalidations" }));
    const feed = screen.getByRole("region", { name: "Followed invalidations" });
    await waitFor(() => expect(within(feed).getAllByRole("listitem").length).toBeGreaterThan(1), { timeout: 2000 });
    expect(within(feed).getAllByRole("listitem")[0]!.textContent).toMatch(/ts \d+ · \S+ wrote \S+ \[/);
  });

  test("a credential without viewMetrics sees no data", async () => {
    mount("/subscriptions", source({ capabilities: { operations: ["viewData"], readOnly: true } }));
    expect(await screen.findByText("This credential cannot view metrics.")).toBeDefined();
    expect(screen.queryByRole("grid", { name: "Live queries" })).toBeNull();
  });
});

describe("on a deployment (STUDY-149's follow-up: AD-25 on a deployment)", () => {
  test("the polls' pace: every 5 s, slower when an answer is slow (1 % of the server's time), at least each minute", () => {
    expect([pollInterval(0), pollInterval(20), pollInterval(50), pollInterval(200), pollInterval(5_000)]).toEqual([
      5_000, 5_000, 5_000, 20_000, 60_000,
    ]);
  });

  test("the live queries and the cache are not asked while disconnected, and are asked at once on return", async () => {
    const src = source();
    const listeners = new Set<(s: ConnectionStatus) => void>();
    Object.assign(src, {
      watchConnection(onStatus: (s: ConnectionStatus) => void) {
        listeners.add(onStatus);
        return () => listeners.delete(onStatus);
      },
    });
    const set = (s: ConnectionStatus) =>
      act(() => {
        for (const l of listeners) l(s);
      });
    const asked = { live: 0, cache: 0 };
    const getSubscriptions = src.getSubscriptions.bind(src);
    const getQueryCache = src.getQueryCache.bind(src);
    src.getSubscriptions = (...a: Parameters<typeof getSubscriptions>) => {
      asked.live++;
      return getSubscriptions(...a);
    };
    src.getQueryCache = (...a: Parameters<typeof getQueryCache>) => {
      asked.cache++;
      return getQueryCache(...a);
    };
    const { history } = mount("/subscriptions", src);
    await screen.findByRole("grid", { name: "Live queries" });
    await waitFor(() => expect(asked.live).toBe(1));
    await set("disconnected");
    await screen.findByRole("alert", { name: "Connection issue" });
    // the filter changes while away: a new key, still not asked
    await act(() => history.push("/subscriptions?path=tasks"));
    await new Promise((r) => setTimeout(r, 50));
    expect(asked.live).toBe(1);
    await set("connected");
    await waitFor(() => expect(asked.live).toBe(2));
    // the cache tab the same
    await act(() => history.push("/subscriptions?tab=cache"));
    await waitFor(() => expect(asked.cache).toBe(1));
    await set("disconnected");
    await act(() => history.push("/subscriptions?tab=cache&path=tasks"));
    await new Promise((r) => setTimeout(r, 50));
    expect(asked.cache).toBe(1);
    await set("connected");
    await waitFor(() => expect(asked.cache).toBe(2));
  });
});

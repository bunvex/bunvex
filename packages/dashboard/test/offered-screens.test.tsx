// bunvex's own screens a source may not offer (STUDY-149 follow-up, offered-screens.tsx): Topology, Authentication
// and Subscriptions are in the sidebar and the palette only for a source with the methods they need, as an
// extension's `requires`; a typed URL says the deployment does not offer them; Convex's screens stay listed.
// The mock offers everything; a source missing the methods stands for a deployment that has no server side yet.
import { afterEach, describe, expect, test } from "bun:test";
import { Dashboard, type DashboardDataSource } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryScopeContext } from "../src/context.tsx";
import { OFFERED_SCREENS, offeredOnly, screenOffered } from "../src/shell/offered-screens.tsx";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 9, 14, 12);
const mock = () =>
  new MockDataSource({
    seed: 4,
    now: NOW,
    executions: 12,
    logIntervalMs: 3_600_000,
    invalidationIntervalMs: 3_600_000,
  });
/** The mock without some optional methods, as a source that does not have them. */
function without(...methods: (keyof DashboardDataSource)[]) {
  const src = mock();
  // biome-ignore lint/suspicious/noExplicitAny: removing optional methods
  for (const m of methods) (src as any)[m] = undefined;
  return src;
}
const NONE = ["getTopology", "listAuthUsers", "getSubscriptions", "listRooms"] as const;

function mount(path: string, src: DashboardDataSource) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return history;
}
const nav = () => screen.getByRole("navigation", { name: "Dashboard" });
const navLinks = () =>
  within(nav())
    .getAllByRole("link")
    .map((a) => a.textContent);

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {}
});

async function paletteTitles(query: string) {
  const user = userEvent.setup();
  await user.keyboard("{Control>}k{/Control}");
  const box = await screen.findByRole("combobox", { name: "Search screens, tables, functions and actions" });
  await user.type(box, query);
  await new Promise((r) => setTimeout(r, 50));
  const list = screen.queryByRole("listbox", { name: "Results" });
  return list
    ? within(list)
        .queryAllByRole("option")
        .map((o) => o.textContent ?? "")
    : [];
}

describe("screenOffered", () => {
  test("a listed screen needs every method; its pages are its own; any other screen is always offered", () => {
    expect(Object.keys(OFFERED_SCREENS).sort()).toEqual(["/auth", "/rooms", "/subscriptions", "/topology"]);
    const all = mock();
    for (const path of Object.keys(OFFERED_SCREENS)) expect(screenOffered(all, path)).toBe(true);
    const none = without(...NONE);
    for (const to of [
      "/topology",
      "/auth",
      "/auth/users",
      "/subscriptions",
      "/subscriptions?path=a",
      "/rooms",
      "/rooms?room=k",
    ])
      expect(screenOffered(none, to)).toBe(false);
    for (const to of ["/", "/database", "/files", "/schedules/functions", "/history", "/logs", "/settings"])
      expect(screenOffered(none, to)).toBe(true);
    // a prefix that is another name is not the screen's page
    expect(screenOffered(none, "/authors")).toBe(true);
    // keyed on each screen's own methods
    const noSubs = without("getSubscriptions");
    expect([screenOffered(noSubs, "/topology"), screenOffered(noSubs, "/subscriptions")]).toEqual([true, false]);
  });
});

describe("offeredOnly (a route's guard)", () => {
  // the screens keep checks of their own; the guard alone is tested here, around a stand-in screen
  const Stand = Object.assign(() => <p>the screen</p>, { preload: async () => {} });
  const at = (src: DashboardDataSource) => {
    const Route = offeredOnly("/subscriptions", Stand);
    render(
      <QueryScopeContext.Provider value={{ source: src, scope: "t" }}>
        <Route />
      </QueryScopeContext.Provider>,
    );
    return Route;
  };

  test("the screen where offered, keeping a lazy screen's preload", () => {
    expect(at(mock()).preload).toBe(Stand.preload);
    expect(screen.getByText("the screen")).toBeDefined();
  });

  test("its entry's words where not, without rendering the screen", () => {
    at(without("getSubscriptions"));
    expect(screen.getByRole("heading", { level: 1, name: "Subscriptions" })).toBeDefined();
    expect(screen.getByText("This deployment does not offer a view of its live queries yet.")).toBeDefined();
    expect(screen.queryByText("the screen")).toBeNull();
  });
});

describe("the sidebar", () => {
  test("the mock offers them all: Topology, Authentication (under Manage) and Subscriptions are listed", async () => {
    mount("/", mock());
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(navLinks()).toEqual(expect.arrayContaining(["Topology", "Authentication", "Subscriptions", "Rooms"]));
    expect(within(nav()).getByText("Manage")).toBeDefined();
  });

  test("a source without them: none listed; Convex's screens stay", async () => {
    mount("/", without(...NONE));
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const links = navLinks();
    for (const name of ["Topology", "Authentication", "Subscriptions", "Rooms"]) expect(links).not.toContain(name);
    expect(links).toEqual(
      expect.arrayContaining(["Overview", "Database", "Schema", "Files", "Functions", "Schedules", "Logs", "History"]),
    );
    await expectAccessible();
  });

  test("Manage keeps an offered extension that joins it, and goes when it would be empty", async () => {
    // the mock's feature flags join Manage (an extension); without authentication it holds them alone
    mount("/", without(...NONE));
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const manage = within(nav()).getByText("Manage").closest("div") as HTMLElement;
    expect(
      within(manage)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).not.toContain("Authentication");
    cleanup();
    // no extension offered either: no empty group
    const bare = new MockDataSource({ seed: 4, now: NOW, executions: 3, extensions: [] });
    // biome-ignore lint/suspicious/noExplicitAny: removing an optional method
    (bare as any).listAuthUsers = undefined;
    mount("/", bare);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(within(nav()).queryByText("Manage")).toBeNull();
    await expectAccessible();
  });

  test("each screen on its own methods: without getSubscriptions only Subscriptions goes", async () => {
    mount("/", without("getSubscriptions"));
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const links = navLinks();
    expect(links).toContain("Topology");
    expect(links).toContain("Authentication");
    expect(links).not.toContain("Subscriptions");
    expect(links).toContain("Rooms");
  });

  test("without listRooms only Rooms goes", async () => {
    mount("/", without("listRooms"));
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const links = navLinks();
    expect(links).toContain("Subscriptions");
    expect(links).not.toContain("Rooms");
  });
});

describe("deep links to a screen not offered", () => {
  for (const [path, heading, words] of [
    ["/topology", "Topology", "This deployment does not offer its topology yet."],
    ["/auth/users", "Authentication", "This deployment does not offer user management yet."],
    ["/auth/providers", "Authentication", "This deployment does not offer user management yet."],
    [
      "/subscriptions?path=messages:list",
      "Subscriptions",
      "This deployment does not offer a view of its live queries yet.",
    ],
    ["/rooms?name=rooms:doc", "Rooms", "This deployment does not offer a view of its rooms and presence scopes yet."],
  ] as const)
    test(`${path} says the deployment does not offer it`, async () => {
      mount(path, without(...NONE));
      await screen.findByRole("heading", { level: 1, name: heading });
      expect(await screen.findByText(words)).toBeDefined();
      // and the sidebar does not list it
      expect(navLinks()).not.toContain(heading);
      await expectAccessible();
    });

  test("the same URLs open their screens on the mock", async () => {
    mount("/subscriptions", mock());
    await screen.findByRole("heading", { level: 1, name: "Subscriptions" });
    expect(screen.queryByText(/does not offer/)).toBeNull();
  });
});

describe("the command palette", () => {
  test("on the mock: the three screens and the auth pages", async () => {
    mount("/", mock());
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect((await paletteTitles("Subscriptions")).some((t) => t.startsWith("Subscriptions"))).toBe(true);
    cleanup();
    mount("/", mock());
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect((await paletteTitles("Topology")).some((t) => t.startsWith("Topology"))).toBe(true);
    cleanup();
    mount("/", mock());
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect((await paletteTitles("Sessions")).some((t) => t.startsWith("Sessions"))).toBe(true);
  });

  test("without them: no entry for the screens or the auth pages; Convex's screens still found", async () => {
    for (const q of ["Topology", "Subscriptions", "Authentication", "Sessions", "Multi-factor"]) {
      mount("/", without(...NONE));
      await screen.findByRole("heading", { level: 1, name: "Overview" });
      const titles = await paletteTitles(q);
      expect(titles.filter((t) => t.startsWith(q))).toEqual([]);
      cleanup();
    }
    mount("/", without(...NONE));
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect((await paletteTitles("History")).some((t) => t.startsWith("History"))).toBe(true);
  });
});

describe("a log line's link to Subscriptions", () => {
  async function why(src: MockDataSource) {
    src.invalidateSomething();
    mount("/logs", src);
    await screen.findByRole("heading", { level: 1, name: "Logs" });
    const grid = () => screen.getByRole("grid", { name: "Log lines" });
    await waitFor(() => expect(within(grid()).getAllByRole("row").length).toBeGreaterThan(3));
    await userEvent.setup().click(within(within(grid()).getAllByRole("row")[1]!).getAllByRole("gridcell").at(-1)!);
    const panel = await screen.findByRole("complementary");
    return within(panel).getByRole("region", { name: "Why it ran" });
  }

  test("shown where Subscriptions is offered", async () => {
    expect(within(await why(mock())).getByRole("link", { name: "Open the invalidation" })).toBeDefined();
  });

  test("not where it is not: the cause stays, the link goes", async () => {
    const region = await why(without("getSubscriptions"));
    expect(within(region).getByTestId("log-why").textContent).toContain("A commit changed what it read");
    expect(
      within(region)
        .queryAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual([]);
  });
});

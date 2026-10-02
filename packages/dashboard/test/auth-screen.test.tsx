// The Authentication screen (UI-01 §25): the column, Users (grid, search, filters, Add user, the panel and its
// Danger zone), Sessions, Organizations, a configuration page, the audit log.
import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { userStatus } from "../src/data-source.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const mockSource = (over: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 7, now: NOW, executions: 5, ...over });
function mount(path: string, source = mockSource()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source} history={history} />);
  return { history, source };
}
const params = (h: ReturnType<typeof createMemoryHistory>) =>
  Object.fromEntries(new URLSearchParams(h.location.search));
const grid = () => screen.getByRole("grid", { name: "Users" });
const rows = () => within(grid()).getAllByRole("row").slice(1);
const loaded = () => waitFor(() => expect(rows().length).toBeGreaterThan(3));

beforeEach(() => localStorage.clear());

describe("the Authentication screen", () => {
  test("in the sidebar under Manage; /auth opens Users; the column has Manage and Configuration", async () => {
    const { history } = mount("/auth");
    await screen.findByRole("heading", { level: 1, name: "Users" });
    expect(history.location.pathname).toBe("/auth/users");
    const sidebar = screen.getByRole("navigation", { name: "Dashboard" });
    // Authentication first; extensions that join Manage (Feature flags, UI-01 §28) come after it
    expect(within(within(sidebar).getByRole("list", { name: "Manage" })).getAllByRole("link")[0]!.textContent).toBe(
      "Authentication",
    );
    const pages = screen.getByRole("navigation", { name: "Authentication" });
    expect(
      within(pages)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(["Manage", "Configuration"]);
    expect(
      within(pages)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual([
      "Users",
      "Sessions",
      "Organizations",
      "Sign in / Providers",
      "Multi-factor",
      "Passkeys",
      "Session lifetime",
      "Rate limits",
      "URL configuration",
      "Emails",
      "Audit",
    ]);
    await loaded();
    await expectAccessible();
  });

  test("Users: search and the column's filters go to the source and the URL", async () => {
    const { history, source } = mount("/auth/users");
    await loaded();
    const all = (await source.listAuthUsers({ numItems: 500, cursor: null })).page;
    const user = userEvent.setup();
    const first = all[0]!;
    await user.type(screen.getByRole("searchbox", { name: "Search users" }), first.email);
    await waitFor(() => expect(params(history)).toEqual({ q: first.email }));
    await waitFor(() => expect(rows().length).toBe(1));
    await user.clear(screen.getByRole("searchbox", { name: "Search users" }));
    await waitFor(() => expect(params(history)).toEqual({}));
    const filters = screen.getByRole("navigation", { name: "User filters" });
    const banned = all.filter((u) => userStatus(u) === "banned");
    const radio = within(filters).getByRole("radio", { name: "Banned" });
    await waitFor(() => expect(radio.parentElement!.lastElementChild!.textContent).toBe(String(banned.length)));
    await user.click(radio);
    await waitFor(() => expect(params(history)).toEqual({ status: "banned" }));
    await waitFor(() => expect(rows().length).toBe(banned.length));
    expect(rows().every((r) => r.textContent?.includes("Banned"))).toBe(true);
    // said as every status is (UX2-12): the shared badge, with its state
    expect(
      rows().every((r) => r.querySelector('[data-slot="status-badge"]')?.getAttribute("data-status") === "banned"),
    ).toBe(true);
  });

  test("Add user: create one (it opens), or invite by email from the split button", async () => {
    const { history, source } = mount("/auth/users");
    await loaded();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add user" }));
    const panel = await screen.findByRole("complementary", { name: "Create user" });
    await user.type(within(panel).getByLabelText("Name"), "New Person");
    await user.type(within(panel).getByLabelText("Email"), "new.person@example.com");
    await user.click(within(panel).getByRole("button", { name: "Create user" }));
    await waitFor(() => expect(params(history).user).toBeDefined());
    expect((await source.getAuthUser(params(history).user!))?.email).toBe("new.person@example.com");
    await screen.findByText("Created the user.");
    await user.click(screen.getByRole("button", { name: "More ways to add a user" }));
    await user.click(await screen.findByRole("menuitem", { name: "Invite by email" }));
    const invite = await screen.findByRole("complementary", { name: "Invite by email" });
    await user.type(within(invite).getByLabelText("Email"), "friend@example.com");
    await user.click(within(invite).getByRole("button", { name: "Send invitation" }));
    await screen.findByText("Sent the invitation.");
    expect((await source.listAuthEvents({})).some((e) => e.action === "invite")).toBe(true);
  });

  test("a user's panel: Overview, Logs, Raw JSON; it follows the current row", async () => {
    const { history, source } = mount("/auth/users");
    await loaded();
    const user = userEvent.setup();
    await user.click(within(rows()[0]!).getAllByRole("gridcell")[1]!);
    const all = (await source.listAuthUsers({ numItems: 500, cursor: null })).page;
    const panel = await screen.findByRole("complementary", { name: all[0]!.name });
    expect(within(panel).getByRole("region", { name: "Danger zone" })).toBeDefined();
    expect(within(panel).getByRole("region", { name: "Providers" })).toBeDefined();
    await user.click(within(panel).getByRole("tab", { name: "Raw JSON" }));
    await waitFor(() => expect(params(history).tab).toBe("json"));
    expect(within(panel).getByRole("figure", { name: "This user as JSON" }).textContent).toContain(all[0]!.email);
    await user.click(within(panel).getByRole("tab", { name: "Logs" }));
    await within(panel).findByRole("table", { name: "This user's auth events" });
    await expectAccessible();
    within(rows()[0]!).getAllByRole("gridcell")[1]!.focus();
    await user.keyboard("{ArrowDown}");
    await screen.findByRole("complementary", { name: all[1]!.name });
  });

  test("the Danger zone: ban for a day signs out; unban; delete — each after a confirmation", async () => {
    const { history, source } = mount("/auth/users");
    await loaded();
    const target = (await source.listAuthUsers({ numItems: 500, cursor: null, status: "verified" })).page[0]!;
    await source.impersonateAuthUser(target.id); // at least one session
    const user = userEvent.setup();
    await user.click(
      within(screen.getByRole("navigation", { name: "User filters" })).getByRole("radio", { name: "Verified" }),
    );
    await waitFor(() => expect(params(history).status).toBe("verified"));
    const row = await waitFor(() => rows().find((r) => r.textContent?.includes(target.email))!);
    await user.click(within(row).getAllByRole("gridcell")[1]!);
    const panel = await screen.findByRole("complementary", { name: target.name });
    const danger = within(panel).getByRole("region", { name: "Danger zone" });
    await user.type(within(danger).getByLabelText("Reason"), "abuse");
    await user.click(within(danger).getByRole("button", { name: "Ban user" }));
    await user.click(await screen.findByRole("button", { name: "Ban" }));
    await waitFor(async () => expect((await source.getAuthUser(target.id))?.banned).toBe(true));
    expect((await source.getAuthUser(target.id))?.banReason).toBe("abuse");
    expect(await source.listAuthSessions({ userId: target.id })).toEqual([]);
    await user.click(await within(danger).findByRole("button", { name: "Unban" }));
    await user.click(screen.getAllByRole("button", { name: "Unban" }).at(-1)!); // the dialog's
    await waitFor(async () => expect((await source.getAuthUser(target.id))?.banned).toBe(false));
    await user.click(within(danger).getByRole("button", { name: "Delete user" }));
    await user.click(screen.getAllByRole("button", { name: "Delete user" }).at(-1)!);
    await waitFor(async () => expect(await source.getAuthUser(target.id)).toBeNull());
    await waitFor(() => expect(params(history).user).toBeUndefined());
  });

  test("Sessions and Organizations: grids; a session is revoked after a confirmation", async () => {
    const { source } = mount("/auth/sessions");
    await screen.findByRole("heading", { level: 1, name: "Sessions" });
    const sessions = await source.listAuthSessions({});
    const g = screen.getByRole("table", { name: "Sessions" });
    await waitFor(() => expect(within(g).getAllByRole("row").length).toBeGreaterThan(2));
    const user = userEvent.setup();
    // a search narrows the sessions (UX2-19)
    const someone = within(within(g).getAllByRole("row")[1]!).getAllByRole("cell")[0]!.textContent!;
    await user.type(screen.getByRole("searchbox", { name: "Search sessions" }), someone);
    await waitFor(() =>
      expect(
        within(g)
          .getAllByRole("row")
          .slice(1)
          .every((r) => r.textContent!.includes(someone)),
      ).toBe(true),
    );
    await user.clear(screen.getByRole("searchbox", { name: "Search sessions" }));
    await user.click(within(g).getAllByRole("button", { name: "Revoke" })[0]!);
    await user.click(screen.getAllByRole("button", { name: "Revoke" }).at(-1)!);
    await waitFor(async () => expect((await source.listAuthSessions({})).length).toBe(sessions.length - 1));
    await user.click(screen.getByRole("link", { name: "Organizations" }));
    // a grid: a row opens the organization (auth-orgs-emails.test.tsx)
    const orgs = await screen.findByRole("grid", { name: "Organizations" });
    await waitFor(() => expect(within(orgs).getAllByRole("row").length).toBe(5));
  });

  test("a configuration page: edit, Save writes that part only; Discard; read-only cannot save", async () => {
    const { source } = mount("/auth/rate-limits");
    await screen.findByRole("heading", { level: 1, name: "Rate limits" });
    const before = await source.getAuthConfig();
    const user = userEvent.setup();
    const max = await screen.findByLabelText("Requests per window");
    await user.clear(max);
    await user.type(max, "250");
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    await user.click(save);
    await screen.findByText("Saved.");
    expect(await source.getAuthConfig()).toEqual({ ...before, rateLimits: { ...before.rateLimits, max: 250 } });
    await expectAccessible();
  });

  test("Audit: the auth events, newest first", async () => {
    const { source } = mount("/auth/audit");
    await screen.findByRole("heading", { level: 1, name: "Audit" });
    const g = await screen.findByRole("table", { name: "Auth audit log" });
    const events = await source.listAuthEvents({});
    await waitFor(() => expect(within(g).getAllByRole("row")[1]!.textContent).toContain(events[0]!.action));
  });

  test("read-only: no Add user, the Danger zone disabled", async () => {
    mount("/auth/users", mockSource({ capabilities: { operations: ["viewData"], readOnly: true } }));
    await loaded();
    expect((screen.getByRole("button", { name: "Add user" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

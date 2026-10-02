// Authentication → Organizations' panel (members, roles, invitations) and → Emails (templates with variables
// and a sandboxed preview), UI-01 §25.2–25.3.
import { beforeEach, describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fill, renderEmail, unknownVariables } from "../src/auth/email-preview.ts";
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

beforeEach(() => localStorage.clear());

describe("email previews", () => {
  test("variables are filled; unknown ones are reported and marked; text is escaped, links kept", () => {
    expect(fill("verify-email", "Hi {{name}}", false)).toBe("Hi Ada Lovelace");
    expect(unknownVariables("magic-link", "Hi {{name}}: {{url}} {{ team }}")).toEqual(["name", "team"]);
    const doc = renderEmail("verify-email", { subject: "For {{name}} {{oops}}", body: "<b>x</b>?" }, "light");
    // a body that looks like HTML is HTML (it runs in a sandboxed iframe); the subject is always text
    expect(doc).toContain("<b>x</b>?");
    expect(doc).toContain("<mark>{{oops}}</mark>");
    const text = renderEmail("password-reset", { subject: "s", body: "a < b\n\nGo: {{url}}" }, "dark");
    expect(text).toContain("<p>a &lt; b</p>");
    expect(text).toMatch(/<a href="https:\/\/acme\.dev\/auth\/verify\?token=/);
    expect(text).toContain("#111316");
  });
});

describe("an organization's panel", () => {
  test("a row opens it (in the URL) with its members; roles change; the last owner is kept", async () => {
    const { history, source } = mount("/auth/organizations");
    const grid = await screen.findByRole("grid", { name: "Organizations" });
    const org = (await source.listAuthOrganizations())[0]!;
    const user = userEvent.setup();
    await user.click(await within(grid).findByText(org.name));
    await waitFor(() => expect(params(history).org).toBe(org.id));
    const panel = await screen.findByRole("complementary", { name: org.name });
    const list = await within(panel).findByRole("list", { name: `Members of ${org.name}` });
    const members = await source.listAuthMembers(org.id);
    expect(within(list).getAllByRole("listitem")).toHaveLength(members.length);
    await expectAccessible();
    // demoting the only owner is refused, and the reason is said
    const owner = members.find((m) => m.role === "owner")!;
    await user.click(within(panel).getByRole("combobox", { name: `Role of ${owner.name}` }));
    await user.click(await screen.findByRole("option", { name: "Member" }));
    expect((await within(panel).findByRole("alert")).textContent).toMatch(/needs an owner/);
    // another member becomes an admin
    const other = members.find((m) => m.role !== "owner")!;
    await user.click(within(panel).getByRole("combobox", { name: `Role of ${other.name}` }));
    await user.click(await screen.findByRole("option", { name: "Admin" }));
    await waitFor(async () =>
      expect((await source.listAuthMembers(org.id)).find((m) => m.id === other.id)?.role).toBe("admin"),
    );
  });

  test("Invitations: invite by email (it is pending), cancel after a confirmation", async () => {
    const source = mockSource();
    const org = (await source.listAuthOrganizations())[0]!;
    const { history } = mount(`/auth/organizations?org=${org.id}&orgTab=invitations`, source);
    const panel = await screen.findByRole("complementary", { name: org.name });
    const user = userEvent.setup();
    await user.type(await within(panel).findByRole("textbox", { name: "Invite by email" }), "new.person@example.com");
    await user.click(within(panel).getByRole("button", { name: "Invite" }));
    await within(panel).findByText("Invited new.person@example.com.");
    const list = within(panel).getByRole("list", { name: `Invitations to ${org.name}` });
    const item = within(list)
      .getAllByRole("listitem")
      .find((li) => li.textContent?.includes("new.person@example.com"))!;
    expect(item.textContent).toContain("Pending");
    await user.click(within(item).getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel invitation" }));
    await waitFor(async () =>
      expect((await source.listAuthInvitations(org.id)).find((i) => i.email === "new.person@example.com")?.status).toBe(
        "canceled",
      ),
    );
    expect(params(history).orgTab).toBe("invitations");
  });
});

describe("Emails", () => {
  test("each template: variables to insert, unknown ones warned, a sandboxed preview in light or dark", async () => {
    mount("/auth/emails");
    const section = await screen.findByRole("region", { name: "Verify email" });
    const body = within(section).getByRole("textbox", { name: "Body" }) as HTMLTextAreaElement;
    const user = userEvent.setup();
    fireEvent.change(body, { target: { value: "Hi " } });
    body.setSelectionRange(3, 3);
    await user.click(within(section).getByRole("button", { name: "Insert {{name}} into the Verify email body" }));
    expect(body.value).toBe("Hi {{name}}");
    fireEvent.change(body, { target: { value: "Hi {{team}}" } });
    expect(within(section).getByText(/reaches the recipient as written: \{\{team\}\}/)).toBeDefined();
    expect(body.getAttribute("aria-invalid")).toBe("true");
    const frame = within(section).getByTitle("Preview of the Verify email email") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("<mark>{{team}}</mark>");
    await user.click(within(section).getByRole("button", { name: "Dark" }));
    expect(frame.getAttribute("srcdoc")).toContain("#111316");
    await expectAccessible();
  });
});

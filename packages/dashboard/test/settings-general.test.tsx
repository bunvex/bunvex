import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const mockSource = () => new MockDataSource({ seed: 7, now: NOW, executions: 5, documents: { tasks: 3, users: 3 } });

function mount(path = "/settings/general", source = mockSource()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={source} history={history} />);
  return { history, source };
}
const section = () => screen.findByRole("region", { name: "Deployment" });
const row = (s: HTMLElement, term: string) =>
  [...s.querySelectorAll("dt")].find((dt) => dt.textContent === term)?.nextElementSibling as HTMLElement | undefined;

describe("Settings: General", () => {
  test("/settings opens General, with General and Environment variables beside it", async () => {
    const { history } = mount("/settings");
    await section();
    expect(history.location.pathname).toBe("/settings/general");
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["General", "Environment variables", "Authentication"]);
    expect(within(nav).getByRole("link", { name: "General" }).getAttribute("aria-current")).toBe("page");
  });

  test("the deployment: name, version, persistence and its two URLs, each copyable", async () => {
    mount();
    const s = await section();
    await within(s).findByText("local");
    expect(row(s, "Version")?.textContent).toBe("0.0.0-mock");
    expect(row(s, "Persistence")?.textContent).toBe("memory");
    expect(row(s, "Client URL")?.textContent).toContain("http://127.0.0.1:3210");
    expect(row(s, "HTTP actions URL")?.textContent).toContain("http://127.0.0.1:3211");
    const user = userEvent.setup(); // installs a clipboard of its own: replace it after
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (t: string) => void writes.push(t) },
      configurable: true,
    });
    await user.click(within(s).getByRole("button", { name: "Copy the HTTP actions URL" }));
    expect(writes).toEqual(["http://127.0.0.1:3211"]);
    await expectAccessible();
  });

  test("a URL the source does not give is left out", async () => {
    const source = mockSource();
    const real = source.getDeployment.bind(source);
    source.getDeployment = async (opts) => ({ ...(await real(opts)), httpActionsUrl: undefined });
    mount("/settings/general", source);
    const s = await section();
    await within(s).findByText("local");
    expect(row(s, "Client URL")?.textContent).toContain("http://127.0.0.1:3210");
    expect(row(s, "HTTP actions URL")).toBeUndefined();
  });

  test("pause: the state in words, a confirmation, then every screen says it; resume undoes it", async () => {
    const { source, history } = mount();
    const pause = await screen.findByRole("region", { name: "Pause deployment" });
    await within(pause).findByText("running");
    expect(within(pause).getByText("New function calls will return an error.")).toBeDefined();
    expect(screen.queryByText(/This deployment is paused/)).toBeNull();
    const user = userEvent.setup();
    await user.click(within(pause).getByRole("button", { name: "Pause deployment" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Pause local?" });
    await expectAccessible(dialog); // the modal hides the page behind it
    await user.click(within(dialog).getByRole("button", { name: "Pause deployment" }));
    await within(pause).findByText("paused");
    expect((await source.getDeploymentState()).state).toBe("paused");
    const banner = await screen.findByText(/This deployment is paused/);
    await expect(source.runFunction("tasks:list", {})).rejects.toThrow("paused");
    // the banner stays on other screens, and links back here
    await user.click(within(banner.closest("[role=status]") as HTMLElement).getByRole("link", { name: "Settings" }));
    expect(history.location.pathname).toBe("/settings/general");
    await user.click(within(pause).getByRole("button", { name: "Resume deployment" }));
    await user.click(
      within(await screen.findByRole("alertdialog", { name: "Resume local?" })).getByRole("button", {
        name: "Resume deployment",
      }),
    );
    await within(pause).findByText("running");
    expect(screen.queryByText(/This deployment is paused/)).toBeNull();
  });

  test("pause: a credential without the operation sees the state but cannot change it", async () => {
    const source = new MockDataSource({
      seed: 7,
      now: NOW,
      executions: 5,
      documents: { tasks: 3, users: 3 },
      capabilities: { operations: ["viewData"], readOnly: false },
    });
    mount("/settings/general", source);
    const pause = await screen.findByRole("region", { name: "Pause deployment" });
    await within(pause).findByText("running");
    expect(within(pause).getByRole("button", { name: "Pause deployment" }).hasAttribute("disabled")).toBe(true);
    expect(within(pause).getByText("This credential cannot pause the deployment.")).toBeDefined();
  });

  test("pause: not shown for a source that does not offer it", async () => {
    const source = mockSource();
    Object.assign(source, { getDeploymentState: undefined, pauseDeployment: undefined, resumeDeployment: undefined });
    mount("/settings/general", source);
    await section();
    expect(screen.queryByRole("region", { name: "Pause deployment" })).toBeNull();
  });
});

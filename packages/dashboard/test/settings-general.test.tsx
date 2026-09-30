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
    ).toEqual(["General", "Environment variables"]);
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
});

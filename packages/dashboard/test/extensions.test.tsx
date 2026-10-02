import { describe, expect, test } from "bun:test";
import { Dashboard, type DashboardDataSource } from "@bunvex/dashboard";
import { describeDataSourceContract } from "@bunvex/dashboard/contract";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { extensions } from "../src/extensions/index.ts";
import { offers } from "../src/extensions/types.ts";
import { expectAccessible } from "./axe.ts";
import { sampleContract, sampleExtension, sampleMock } from "./fixtures/sample-extension.tsx";

const NOW = Date.UTC(2026, 9, 1, 12);
const withSample = () => new MockDataSource({ seed: 2, now: NOW, executions: 5, extensions: [sampleMock] });
const without = () => new MockDataSource({ seed: 2, now: NOW, executions: 5, extensions: [] });

// the same screen, listed in a built-in group (Data) rather than its own "Extensions" group
const inData = {
  ...sampleExtension,
  id: "sample-data",
  title: "Data samples",
  nav: { group: "data" as const, order: 1, to: "/data-samples" },
  routes: [{ ...sampleExtension.routes[0]!, path: "data-samples" }],
};

function mount(path: string, src: DashboardDataSource) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} extensions={[sampleExtension, inData]} />);
  return { history };
}
const nav = () => screen.getByRole("navigation", { name: "Dashboard" });

describe("extensions (UI-01 §26)", () => {
  test("the registry ships no sample: it is for these tests only", () => {
    expect(extensions.some((e) => e.id === "sample")).toBe(false);
  });

  test("offers() is the source having every required method", () => {
    expect(offers(withSample(), sampleExtension)).toBe(true);
    expect(offers(without(), sampleExtension)).toBe(false);
  });

  test("an offered extension joins its sidebar group and its route renders its lazy screen", async () => {
    mount("/samples", withSample());
    expect(await screen.findByRole("heading", { level: 1, name: "Samples" })).toBeDefined();
    const items = await within(screen.getByRole("list", { name: "Samples" })).findAllByRole("listitem");
    expect(items.length).toBe(2);
    const group = within(nav()).getByText("Extensions");
    expect(group).toBeDefined();
    const link = within(nav()).getByRole("link", { name: "Samples" });
    expect(link.getAttribute("aria-current")).toBe("page");
    // in a built-in group, after its own entries
    const data = within(nav()).getByText("Data").closest("div")!;
    const names = within(data as HTMLElement)
      .getAllByRole("link")
      .map((a) => a.textContent);
    expect(names.at(-1)).toBe("Data samples");
    await expectAccessible();
  });

  test("a source without the method: no sidebar entry, and the route says it is not offered", async () => {
    mount("/samples", without());
    expect(await screen.findByText(/does not offer samples/)).toBeDefined();
    expect(within(nav()).queryByRole("link", { name: "Samples" })).toBeNull();
    expect(within(nav()).queryByText("Extensions")).toBeNull();
    expect(within(nav()).queryByRole("link", { name: "Data samples" })).toBeNull();
  });

  test("a mock part shares the mock's audit log", async () => {
    const src = withSample();
    await (src as unknown as { listSamples(): Promise<string[]> }).listSamples();
    const page = await src.listAuditEvents!({ numItems: 10, cursor: null });
    expect(page.page.some((e) => e.action === "list_samples")).toBe(true);
  });
});

// the contract suite runs an extension's part when the source offers it
describeDataSourceContract("extensions: MockDataSource with the sample", withSample, { extensions: [sampleContract] });

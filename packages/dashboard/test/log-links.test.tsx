// "Why did this run" links from the Logs screen (STUDY-131 AD-27, a bunvex addition): a live query's run links to
// its entry in Subscriptions with the invalidation that caused it marked, and a traced run to its trace in the
// host's trace UI (`traceUrl`, unset by default). The mock logs such runs when a commit invalidates its queries.
import { afterEach, describe, expect, test } from "bun:test";
import { Dashboard, type LogEntry } from "@bunvex/dashboard";
import { expectExecutionLinks } from "@bunvex/dashboard/contract";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { traceHref } from "../src/context.tsx";
import { validateSubscriptionsSearch } from "../src/router.tsx";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 9, 6, 12);
const source = () =>
  new MockDataSource({
    seed: 7,
    now: NOW,
    executions: 12,
    logIntervalMs: 3_600_000,
    invalidationIntervalMs: 3_600_000,
  });

function mount(src: MockDataSource, traceUrl?: string, path = "/logs") {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} traceUrl={traceUrl} />);
  return history;
}

afterEach(cleanup);

/** A commit invalidates live queries; the newest log line is the run it caused. */
function rerun(src: MockDataSource): LogEntry {
  const { logged } = src.invalidateSomething();
  expect(logged).toHaveLength(1);
  return logged[0]!;
}

const grid = () => screen.getByRole("grid", { name: "Log lines" });
const rows = () => within(grid()).getAllByRole("row").slice(1);

async function openNewest() {
  await screen.findByRole("heading", { level: 1, name: "Logs" });
  await waitFor(() => expect(rows().length).toBeGreaterThan(3));
  const user = userEvent.setup();
  await user.click(within(rows()[0]!).getAllByRole("gridcell").at(-1)!);
  const panel = await screen.findByRole("complementary");
  return { user, panel, why: () => within(panel).getByRole("region", { name: "Why it ran" }) };
}

describe("the mock's re-runs", () => {
  test("each names its live query and the invalidation in its history, and a trace", async () => {
    const src = source();
    const run = rerun(src);
    expectExecutionLinks([run]);
    const sub = run.execution!.links!.subscription!;
    expect(sub.reason).toBe("invalidation");
    expect(run.execution!.links!.trace).toBeDefined();
    const live = (await src.getSubscriptions()).sessions.flatMap((s) => s.queries);
    const q = live.find((x) => x.path === run.function!.path && x.argsDigest === sub.argsDigest)!;
    const [newest] = q.history;
    expect(newest).toMatchObject({ kind: "invalidation", seq: sub.invalidation!.seq });
    expect(newest!.kind === "invalidation" && newest!.commitTs).toBe(sub.invalidation!.commitTs);
    // it is listed as the newest line
    expect((await src.listLogs({ numItems: 1, cursor: null })).page[0]).toEqual(run);
  });
});

describe("the trace URL template", () => {
  const trace = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" };
  test("placeholders replaced; a base URL gets the id appended; unset gives no link", () => {
    expect(traceHref("http://jaeger.test/trace/{traceId}?uiFind={spanId}", trace)).toBe(
      "http://jaeger.test/trace/0af7651916cd43dd8448eb211c80319c?uiFind=b7ad6b7169203331",
    );
    expect(traceHref("http://jaeger.test/trace/", trace)).toBe(
      "http://jaeger.test/trace/0af7651916cd43dd8448eb211c80319c",
    );
    expect(traceHref(undefined, trace)).toBeUndefined();
    expect(traceHref("", trace)).toBeUndefined();
  });

  test("the Subscriptions screen's link parameters", () => {
    expect(validateSubscriptionsSearch({ path: "tasks:list", args: "1a2b3c4d5e6f", seq: "12" })).toMatchObject({
      path: "tasks:list",
      args: "1a2b3c4d5e6f",
      seq: 12,
    });
    for (const seq of ["0", "-1", "1.5", "x", ""]) expect(validateSubscriptionsSearch({ seq }).seq).toBeUndefined();
  });
});

describe("a log line's details", () => {
  test("say why the query ran, link to its invalidation, and show its trace id (no link by default)", async () => {
    const src = source();
    const run = rerun(src);
    const links = run.execution!.links!;
    mount(src);
    const why = (await openNewest()).why();
    expect(within(why).getByTestId("log-why").textContent).toContain(
      `A commit changed what it read (commit ts ${links.subscription!.invalidation!.commitTs})`,
    );
    const to = within(why).getByRole("link", { name: "Open the invalidation" }).getAttribute("href")!;
    const url = new URL(to, "http://x");
    expect(url.pathname).toBe("/subscriptions");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      path: run.function!.path,
      args: links.subscription!.argsDigest,
      seq: String(links.subscription!.invalidation!.seq),
    });
    expect(within(why).getByTestId("log-trace").textContent).toContain(links.trace!.traceId);
    expect(within(why).queryByRole("link", { name: "Open trace" })).toBeNull();
    await expectAccessible();
  });

  test("with a trace URL template, link to the trace", async () => {
    const src = source();
    const { traceId, spanId } = rerun(src).execution!.links!.trace!;
    mount(src, "http://tempo.test/explore?trace={traceId}&span={spanId}");
    const why = (await openNewest()).why();
    const a = within(why).getByRole("link", { name: "Open trace" });
    expect(a.getAttribute("href")).toBe(`http://tempo.test/explore?trace=${traceId}&span=${spanId}`);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
  });

  test("a line with no links has no section", async () => {
    const src = source();
    expect((await src.listLogs({ numItems: 1, cursor: null })).page[0]!.execution?.links).toBeUndefined();
    mount(src);
    const { panel } = await openNewest();
    expect(within(panel).getByText("Started by")).toBeDefined();
    expect(within(panel).queryByRole("region", { name: "Why it ran" })).toBeNull();
  });

  test("following the link opens the query in Subscriptions with that invalidation marked", async () => {
    const src = source();
    const run = rerun(src);
    const sub = run.execution!.links!.subscription!;
    const history = mount(src);
    const { user, why } = await openNewest();
    await user.click(within(why()).getByRole("link", { name: "Open the invalidation" }));
    await screen.findByRole("heading", { level: 1, name: "Subscriptions" });
    expect(history.location.pathname).toBe("/subscriptions");
    const panel = await screen.findByRole("complementary", { name: "Live query" });
    await waitFor(() => expect(within(panel).getByText(run.function!.path)).toBeDefined());
    expect(within(panel).getByText(sub.argsDigest)).toBeDefined();
    const ran = within(panel).getByRole("region", { name: "Why it ran" });
    const marked = within(ran)
      .getAllByRole("listitem")
      .filter((li) => li.getAttribute("aria-current") === "true");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toContain(`Commit ts ${sub.invalidation!.commitTs}`);
    expect(marked[0]!.textContent).toContain("The run the log entry is for");
    await expectAccessible();
  });

  test("an invalidation no longer in the query's history says so", async () => {
    const src = source();
    const run = rerun(src);
    const sub = run.execution!.links!.subscription!;
    mount(src, undefined, `/subscriptions?path=${run.function!.path}&args=${sub.argsDigest}&seq=999999`);
    const panel = await screen.findByRole("complementary", { name: "Live query" });
    await waitFor(() =>
      expect(within(panel).getByText(/\(#999999\) is no longer in this query's history/)).toBeDefined(),
    );
    expect(
      within(panel)
        .queryAllByRole("listitem")
        .some((li) => li.getAttribute("aria-current") === "true"),
    ).toBe(false);
  });
});

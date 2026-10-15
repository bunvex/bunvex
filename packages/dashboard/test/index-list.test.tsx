// The Database screen's index list (STUDY-149 "Index list"), as Convex's `IndexList.tsx`: database, search and vector
// indexes in their own sections, staged ones marked, a backfill's progress (capped at 99 %, a spinner while the
// total is unknown, "Backfill completed" for a built staged index), the staged-index hint, and the list kept live
// from `watchIndexes`. On a deployment, packages/sync-e2e/dashboard/server-source.test.ts and the e2e.
import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, within } from "@testing-library/react";
import { DataSourceError, type IndexListEntry } from "../src/data-source.ts";
import { indexListOf, suggestsStaging } from "../src/database/index-list-model.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const options = { seed: 5, now: NOW, documents: { tasks: 60, users: 6, messages: 4, imports: 5 }, executions: 10 };

/** A mock whose index list the test drives: each `watchIndexes` call's callbacks are kept. */
class DrivenSource extends MockDataSource {
  watchers: {
    table: string;
    onIndexes: (l: IndexListEntry[] | null) => void;
    onError: (e: DataSourceError) => void;
  }[] = [];
  override watchIndexes(
    table: string,
    onIndexes: (l: IndexListEntry[] | null) => void,
    onError: (e: DataSourceError) => void,
  ) {
    const w = { table, onIndexes, onError };
    this.watchers.push(w);
    return () => {
      this.watchers = this.watchers.filter((x) => x !== w);
    };
  }
  push(list: IndexListEntry[] | null) {
    act(() => {
      for (const w of this.watchers) w.onIndexes(list);
    });
  }
}

function mount(path: string, source: MockDataSource = new MockDataSource(options)) {
  render(<Dashboard dataSource={source} history={createMemoryHistory({ initialEntries: [path] })} />);
  return source;
}
const panelOf = (table: string) => screen.findByRole("complementary", { name: `Indexes of ${table}` });
const section = (panel: HTMLElement, name: string) => within(panel).getByRole("region", { name });

const database = (name: string, fields: string[], backfill: IndexListEntry["backfill"], staged = false) =>
  ({ name, staged, fields: [...fields, "_creationTime"], backfill }) satisfies IndexListEntry;

describe("the index list", () => {
  test("three sections: database, search and vector indexes, without by_id and by_creation_time", async () => {
    mount("/database/messages?panel=indexes");
    const panel = await panelOf("messages");
    const db = section(panel, "Indexes");
    await within(panel).findByRole("listitem", { name: "by_channel" });
    expect(
      within(db)
        .getAllByRole("listitem")
        .map((li) => li.getAttribute("aria-label")),
    ).toEqual(["by_channel"]);
    expect(within(db).getByRole("listitem", { name: "by_channel" }).textContent).toContain(
      "Fields:channel, _creationTime",
    );
    expect(panel.textContent).not.toContain("by_id");
    expect(panel.textContent).not.toContain("by_creation_time");

    const search = within(section(panel, "Search indexes")).getByRole("listitem", { name: "search_body" });
    expect(search.textContent).toContain("Search field:body");
    expect(search.textContent).toContain("Filter fields:channel");

    const vector = within(section(panel, "Vector indexes")).getByRole("listitem", { name: "by_embedding" });
    expect(vector.textContent).toContain("Vector field:embedding");
    expect(vector.textContent).toContain("Filter fields:author");
    expect(vector.textContent).toContain("Dimensions:1536");
    expect(vector.textContent).toContain("staged");
    expect(vector.textContent).toContain("Staged indexes are not queryable");
    await expectAccessible(panel);
  });

  test("an empty section says so; a backfill's bar is capped at 99 %; a built staged index is completed", async () => {
    mount("/database/tasks?panel=indexes");
    const panel = await panelOf("tasks");
    await within(panel).findByRole("listitem", { name: "by_text" });
    expect(section(panel, "Search indexes").textContent).toContain("tasks has no search indexes.");
    expect(section(panel, "Vector indexes").textContent).toContain("tasks has no vector indexes.");
    // 610 of 60 indexed (the count is an estimate that can pass the total): 99 %, as Convex's
    const bar = within(panel).getByRole("progressbar", { name: "Backfill of by_text" });
    expect(bar.getAttribute("aria-valuenow")).toBe("99");
    const staged = within(panel).getByRole("listitem", { name: "by_owner_done" });
    expect(staged.textContent).toContain("Backfill completed");
    expect(within(staged).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    // a ready index has no backfill line
    expect(within(panel).getByRole("listitem", { name: "by_owner" }).textContent).not.toContain("Backfill");
  });

  test("live: each list the source sends replaces the shown one; a spinner while the total is unknown", async () => {
    const source = mount("/database/users?panel=indexes", new DrivenSource(options)) as DrivenSource;
    const panel = await panelOf("users");
    expect(panel.textContent).toContain("Loading the indexes…");
    source.push([database("by_email", ["email"], { state: "done" })]);
    await within(panel).findByRole("listitem", { name: "by_email" });
    source.push([
      database("by_email", ["email"], { state: "done" }),
      {
        name: "search_name",
        staged: false,
        fields: { searchField: "name", filterFields: [] },
        backfill: { state: "backfilling", stats: { numDocsIndexed: 0, totalDocs: null } },
      },
    ]);
    const building = await within(panel).findByRole("listitem", { name: "search_name" });
    expect(building.textContent).toContain("Backfill in progress");
    expect(within(building).queryByRole("progressbar")).toBeNull();
    // no filter fields: no "Filter fields" line, as Convex's
    expect(building.textContent).not.toContain("Filter fields");
    source.push([
      database("by_email", ["email"], { state: "done" }),
      {
        name: "search_name",
        staged: false,
        fields: { searchField: "name", filterFields: [] },
        backfill: { state: "done" },
      },
    ]);
    await act(async () => {});
    expect(within(panel).getByRole("listitem", { name: "search_name" }).textContent).not.toContain("Backfill");
  });

  test("the staged-index hint: a large table's index backfilling and not staged", async () => {
    const source = mount("/database/users?panel=indexes", new DrivenSource(options)) as DrivenSource;
    const panel = await panelOf("users");
    const big = { state: "backfilling" as const, stats: { numDocsIndexed: 10, totalDocs: 10_001 } };
    source.push([database("by_email", ["email"], big, true)]);
    await within(panel).findByRole("listitem", { name: "by_email" });
    expect(within(panel).queryByRole("note")).toBeNull();
    source.push([database("by_email", ["email"], big)]);
    expect((await within(panel).findByRole("note")).textContent).toContain("consider a staged index");
  });

  test("a table that does not exist lists nothing; an error is shown", async () => {
    const source = mount("/database/users?panel=indexes", new DrivenSource(options)) as DrivenSource;
    const panel = await panelOf("users");
    source.push(null);
    await within(panel).findByText("has no indexes.", { exact: false });
    act(() => {
      for (const w of source.watchers) w.onError(new DataSourceError("unavailable", "the socket closed"));
    });
    expect((await within(panel).findByRole("alert")).textContent).toContain("the socket closed");
  });

  test("a source without watchIndexes lists its tables' declared database indexes", async () => {
    const source = new MockDataSource(options);
    (source as { watchIndexes?: unknown }).watchIndexes = undefined;
    mount("/database/tasks?panel=indexes", source);
    const panel = await panelOf("tasks");
    const names = within(section(panel, "Indexes"))
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("aria-label"));
    expect(names).toEqual(["by_owner", "by_done_priority", "by_text"]);
  });
});

describe("the index list's model", () => {
  test("indexListOf: declared indexes with _creationTime, a backfill's counts", () => {
    expect(
      indexListOf([
        { name: "by_id", fields: ["_id"], system: true, state: "ready" },
        { name: "by_a", fields: ["a"], system: false, state: "ready" },
        { name: "by_b", fields: ["b"], system: false, state: "backfilling", progress: { indexed: 3 } },
      ]),
    ).toEqual([
      database("by_a", ["a"], { state: "done" }),
      database("by_b", ["b"], { state: "backfilling", stats: { numDocsIndexed: 3, totalDocs: null } }),
    ]);
  });

  test("suggestsStaging: past 10 000 documents, backfilling, not staged", () => {
    const at = (totalDocs: number | null, staged = false, state: "backfilling" | "done" = "backfilling") => [
      database("x", ["x"], { state, stats: { numDocsIndexed: 0, totalDocs } }, staged),
    ];
    expect(suggestsStaging(at(10_001))).toBe(true);
    expect(suggestsStaging(at(10_000))).toBe(false);
    expect(suggestsStaging(at(null))).toBe(false);
    expect(suggestsStaging(at(20_000, true))).toBe(false);
    expect(suggestsStaging(at(20_000, false, "done"))).toBe(false);
  });
});

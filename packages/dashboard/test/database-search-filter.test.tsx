// The Database screen's search filter (STUDY-163 §5), as Convex's filter bar: a search index in the index picker, the
// text searched in its search field, equalities on its filter fields, field filters on top, results by relevance;
// leaving the search starts over. The model's draft and URL round trips. On a deployment: the sync-e2e and
// differential tests.
import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FilterExpression, IndexInfo } from "../src/data-source.ts";
import { emptyDraft, fromDraft, setIndex, toDraft } from "../src/database/filter-model.ts";
import { decodeFilter, encodeFilter, isEmptyFilter } from "../src/database/filter-url.ts";
import { validateFilter } from "../src/filters.ts";
import { searchDocuments } from "../src/mock/search.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const source = () =>
  new MockDataSource({ seed: 5, now: NOW, documents: { tasks: 5, users: 4, messages: 40, imports: 2 } });

function mount(path: string, src = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}
const grid = () => screen.getByRole("grid", { name: "Documents in messages" });
const column = (name: string) => {
  const t = grid();
  const i = within(t)
    .getAllByRole("columnheader")
    .findIndex((h) => h.textContent === name);
  return within(t)
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("gridcell")[i]!.textContent ?? "");
};

const SYSTEM: IndexInfo[] = [
  { name: "by_id", fields: ["_id"], system: true, state: "ready" },
  { name: "by_creation_time", fields: ["_creationTime"], system: true, state: "ready" },
];
const SEARCH = [{ name: "search_body", searchField: "body", filterFields: ["channel"] }];
const expr = (more: Partial<FilterExpression> = {}): FilterExpression => ({
  clauses: [],
  order: "asc",
  search: { name: "search_body", search: "hello", clauses: [] },
  ...more,
});

describe("the search filter's model", () => {
  test("validation, in Convex's words", () => {
    expect(validateFilter(expr(), SYSTEM, SEARCH).name).toBe("by_creation_time");
    const refused = (e: FilterExpression) => {
      try {
        validateFilter(e, SYSTEM, SEARCH);
        return null;
      } catch (x) {
        return (x as Error).message;
      }
    };
    expect(refused(expr({ order: "desc" }))).toBe("Trying to query search index `search_body` in descending order.");
    expect(refused(expr({ search: { name: "nope", search: "", clauses: [] } }))).toBe("Index nope does not exist.");
    expect(refused(expr({ search: { name: "by_id", search: "", clauses: [] } }))).toBe(
      "Index by_id is not a search index, but the query is trying to use it as search index.",
    );
    expect(
      refused(
        expr({ search: { name: "search_body", search: "x", clauses: [{ field: "body", value: 1, enabled: true }] } }),
      ),
    ).toBe(
      "Invalid index filter selection: found a filter for field `body` which is not part of the filter fields of the search index `search_body`.",
    );
    const twice = [
      { field: "channel", value: "a", enabled: true },
      { field: "channel", value: "b", enabled: true },
    ];
    expect(refused(expr({ search: { name: "search_body", search: "x", clauses: twice } }))).toBe(
      "Invalid filter: there are multiple filters for field `channel`.",
    );
    // a disabled equality is not checked, as Convex's
    expect(
      refused(
        expr({ search: { name: "search_body", search: "x", clauses: [{ ...twice[0]!, enabled: false }, twice[1]!] } }),
      ),
    ).toBeNull();
    expect(refused({ ...expr(), index: { name: "by_id", eq: [] } })).toBe(
      "a search cannot be combined with an index range",
    );
  });

  test("the draft: to a search index the field clauses stay and the order is relevance; leaving it starts over", () => {
    const withClause = {
      ...emptyDraft(),
      clauses: [{ id: "a", field: "n", op: "eq" as const, text: "1", enabled: true }],
    };
    const searching = setIndex(withClause, "search_body", true);
    expect(searching).toMatchObject({ index: "search_body", order: "asc", search: { text: "", eq: [] } });
    expect(searching.clauses).toHaveLength(1);
    const typed = {
      ...searching,
      search: { text: "hi", eq: [{ field: "channel", text: '"general"', enabled: true }] },
    };
    expect(fromDraft(typed).expr).toEqual({
      clauses: [{ id: "a", field: "n", op: "eq", value: 1, enabled: true }],
      order: "asc",
      search: { name: "search_body", search: "hi", clauses: [{ field: "channel", value: "general", enabled: true }] },
    });
    expect(toDraft(fromDraft(typed).expr)).toEqual(typed);
    expect(
      fromDraft({ ...typed, search: { text: "", eq: [{ field: "channel", text: "oops", enabled: true }] } }).errors,
    ).toHaveProperty(["search.0"]);
    expect(setIndex(typed, "by_creation_time")).toEqual(emptyDraft());
  });

  test("the URL: a search round-trips, a malformed one is no filter, a search is never the empty filter", () => {
    const e = expr({
      search: { name: "search_body", search: "hé", clauses: [{ field: "channel", value: "x", enabled: false }] },
    });
    expect(decodeFilter(encodeFilter(e))).toEqual(e);
    expect(decodeFilter(encodeFilter({ ...e, search: { name: "s", search: 1 } as never }))).toBeNull();
    expect(isEmptyFilter({ clauses: [], order: "desc", search: { name: "s", search: "", clauses: [] } })).toBe(false);
  });

  test("the mock's search: words, the last one a prefix, ranked by matches; empty finds nothing", () => {
    const docs = [
      { _id: "1", _creationTime: 1, body: "hello world" },
      { _id: "2", _creationTime: 2, body: "Hello there, world!" },
      { _id: "3", _creationTime: 3, body: "goodbye" },
      { _id: "4", _creationTime: 4, body: 5 },
    ];
    const ids = (s: string) => searchDocuments(docs, SEARCH[0]!, s).map((d) => d._id);
    expect(ids("world hello")).toEqual(["2", "1"]);
    expect(ids("wor")).toEqual(["2", "1"]);
    expect(ids("there wor")).toEqual(["2", "1"]);
    expect(ids("good")).toEqual(["3"]);
    expect(ids("")).toEqual([]);
    expect(ids("  !! ")).toEqual([]);
  });
});

describe("the search filter on the Database screen", () => {
  test("pick the search index, type a word, add an equality; results by relevance; leave the search", async () => {
    const src = source();
    const all = (await src.listDocuments({ table: "messages", numItems: 100, cursor: null })).page;
    const word = String(all[0]!.body).split(" ")[0]!;
    const channel = String(all[0]!.channel);
    const { history } = mount("/database/messages", src);
    await screen.findByRole("heading", { level: 1, name: "messages" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Index" }));
    await user.click(await screen.findByRole("option", { name: "search_body (search)" }));
    const box = await screen.findByRole("searchbox", { name: "Search body" });
    expect(screen.getByText("By relevance")).toBeDefined();
    // nothing searched yet: nothing found, as a search query
    await waitFor(() => expect(screen.queryAllByRole("row").length).toBeLessThanOrEqual(2));
    await user.type(box, word);
    await waitFor(() => {
      const bodies = column("body");
      expect(bodies.length).toBeGreaterThan(0);
      for (const b of bodies) expect(b.toLowerCase()).toContain(word.toLowerCase());
    });
    const applied = decodeFilter(new URLSearchParams(history.location.search).get("filter") ?? undefined);
    expect(applied?.search).toEqual({ name: "search_body", search: word, clauses: [] });
    await user.click(screen.getByRole("button", { name: "channel =" }));
    await user.type(screen.getByRole("textbox", { name: "channel equals" }), JSON.stringify(channel));
    await waitFor(() => expect(new Set(column("channel"))).toEqual(new Set([channel])));
    await expectAccessible(screen.getByRole("region", { name: "Filters" }));
    // back to a database index: the search and its equality are gone, newest first
    await user.click(screen.getByRole("combobox", { name: "Index" }));
    await user.click(await screen.findByRole("option", { name: "by_creation_time" }));
    await waitFor(() => expect(screen.queryByRole("searchbox", { name: "Search body" })).toBeNull());
    await waitFor(() => expect(new URLSearchParams(history.location.search).get("filter")).toBeNull());
    expect(column("body").length).toBeGreaterThan(0);
  });

  test("a link with a search opens searching, the bar showing it", async () => {
    const filter = encodeFilter({
      clauses: [],
      order: "asc",
      search: { name: "search_body", search: "zzzz-nothing", clauses: [] },
    });
    mount(`/database/messages?filter=${filter}`);
    const box = (await screen.findByRole("searchbox", { name: "Search body" })) as HTMLInputElement;
    expect(box.value).toBe("zzzz-nothing");
    expect(await screen.findByText("No document matches these filters.")).toBeDefined();
  });
});

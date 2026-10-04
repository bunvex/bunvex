// The pagination example end to end (STUDY-90): pages that load on demand and stay live.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
  for (let i = 1; i <= 12; i++)
    await d.http.mutation(api.messages.send, { body: `m${i}`, author: i % 3 === 0 ? "Ada" : "bot" });
});
afterAll(() => d?.stop());

type Item = { body: string };
type Page = { results: Item[]; status: string; loadMore: (n: number) => boolean };

test("a paginated subscription: the first page, loadMore, then a new message at the top, live", async () => {
  let latest: Page | undefined;
  d.client().onPaginatedUpdate_experimental(api.messages.list, {}, { initialNumItems: 5 }, (r) => {
    latest = r as Page;
  });
  const first = await until(() => latest?.status === "CanLoadMore" && latest, "the first page");
  expect(first.results.map((m) => m.body)).toEqual(["m12", "m11", "m10", "m9", "m8"]);
  first.loadMore(5);
  await until(() => latest?.results.length === 10, "the second page");
  latest!.loadMore(5);
  const all = await until(() => latest?.status === "Exhausted" && latest, "every page");
  expect(all.results.map((m) => m.body)).toEqual(Array.from({ length: 12 }, (_, i) => `m${12 - i}`));
  await d.http.mutation(api.messages.send, { body: "new", author: "Grace" });
  await until(() => latest?.results[0]?.body === "new", "the new message on top");
  expect(latest!.results).toHaveLength(13);
});

test("pagination over an index, with an argument", async () => {
  const page = await d.http.query(api.messages.listByAuthor, {
    author: "Ada",
    paginationOpts: { numItems: 2, cursor: null },
  });
  expect(page.page.map((m) => m.body)).toEqual(["m12", "m9"]);
  expect(page.isDone).toBe(false);
  const next = await d.http.query(api.messages.listByAuthor, {
    author: "Ada",
    paginationOpts: { numItems: 10, cursor: page.continueCursor },
  });
  expect(next.page.map((m) => m.body)).toEqual(["m6", "m3"]);
  expect(next.isDone).toBe(true);
});

test("a page reshaped before it is returned", async () => {
  const page = await d.http.query(api.messages.listShouted, { paginationOpts: { numItems: 2, cursor: null } });
  expect(page.page).toEqual([
    { author: "G", body: "NEW" },
    { author: "A", body: "M12" },
  ]);
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});

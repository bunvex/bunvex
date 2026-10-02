import { describe, expect, test } from "bun:test";
import { Dashboard, type DashboardDataSource } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { flagsContract } from "../src/extensions/flags/contract.ts";
import {
  bucketOf,
  conditionText,
  evaluate,
  flagProblem,
  pickFromRollout,
  ruleText,
} from "../src/extensions/flags/logic.ts";
import type { FeatureFlag, FlagInput } from "../src/extensions/flags/types.ts";
import { expectAccessible } from "./axe.ts";

const source = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 6, now: Date.now(), executions: 10, ...opts });
function mount(path: string, src: DashboardDataSource = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return { history, src };
}
const heading = () => screen.findByRole("heading", { level: 1, name: "Feature flags" });
const grid = () => screen.getByRole("grid", { name: "Feature flags" });
const keys = () =>
  within(grid())
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("gridcell")[0]!.textContent);

const flag = (over: Partial<FeatureFlag> = {}): FeatureFlag => ({
  key: "f",
  name: "F",
  type: "boolean",
  enabled: true,
  variants: [
    { key: "on", value: true },
    { key: "off", value: false },
  ],
  offVariant: "off",
  rules: [],
  fallthrough: { variant: "on" },
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: null,
  ...over,
});

describe("flag evaluation (UI-01 §28)", () => {
  test("an identity keeps its bucket; a rollout picks by cumulative weight", () => {
    const b = bucketOf("f", { email: "ada@x.dev" });
    expect(bucketOf("f", { email: "ada@x.dev" })).toBe(b);
    expect(b >= 0 && b < 100).toBe(true);
    const r = [
      { variant: "a", weight: 25 },
      { variant: "b", weight: 75 },
    ];
    expect(pickFromRollout(r, 0)).toBe("a");
    expect(pickFromRollout(r, 24.99)).toBe("a");
    expect(pickFromRollout(r, 25)).toBe("b");
    // a 25 % rollout serves about a quarter of many identities
    const on = Array.from({ length: 4000 }, (_, i) =>
      evaluate(
        flag({
          fallthrough: {
            rollout: [
              { variant: "on", weight: 25 },
              { variant: "off", weight: 75 },
            ],
          },
        }),
        {
          email: `u${i}@x.dev`,
        },
      ),
    ).filter((e) => e.variant === "on").length;
    expect(on / 4000).toBeGreaterThan(0.22);
    expect(on / 4000).toBeLessThan(0.28);
  });

  test("off serves the off variant; the first matching rule wins; else the default", () => {
    const f = flag({
      fallthrough: { variant: "off" },
      rules: [
        {
          id: "r1",
          conditions: [{ attribute: "email", operator: "endsWith", values: ["@acme.com"] }],
          serve: { variant: "on" },
        },
        { id: "r2", conditions: [{ attribute: "email", operator: "exists", values: [] }], serve: { variant: "off" } },
      ],
    });
    expect(evaluate({ ...f, enabled: false }, { email: "a@acme.com" })).toMatchObject({
      variant: "off",
      reason: "off",
    });
    expect(evaluate(f, { email: "a@acme.com" })).toMatchObject({
      variant: "on",
      reason: "rule",
      ruleId: "r1",
      value: true,
    });
    expect(evaluate(f, { email: "a@globex.com" })).toMatchObject({ variant: "off", ruleId: "r2" });
    expect(evaluate(f, {})).toMatchObject({ variant: "off", reason: "fallthrough" });
  });

  test("what makes a flag invalid, said plainly; rules in words", () => {
    const ok = flag() as FlagInput;
    expect(flagProblem(ok)).toBeUndefined();
    expect(flagProblem({ ...ok, key: "Bad Key" })).toMatch(/starts with a letter/);
    expect(flagProblem(ok, ["f"])).toBe('A flag "f" already exists.');
    expect(flagProblem({ ...ok, offVariant: "x" })).toBe('The off variant "x" is not one of the variants.');
    expect(
      flagProblem({
        ...ok,
        fallthrough: {
          rollout: [
            { variant: "on", weight: 30 },
            { variant: "off", weight: 30 },
          ],
        },
      }),
    ).toBe("The default's rollout adds up to 60 %, not 100 %.");
    expect(flagProblem({ ...ok, rules: [{ id: "r", conditions: [], serve: { variant: "on" } }] })).toBe(
      "Rule 1 has no condition.",
    );
    expect(conditionText({ attribute: "org", operator: "in", values: ["acme", "globex"] })).toBe(
      'org is one of "acme", "globex"',
    );
    expect(
      ruleText({
        id: "r",
        conditions: [{ attribute: "email", operator: "exists", values: [] }],
        serve: { variant: "on" },
      }),
    ).toBe("If email is set, serve on");
  });
});

describe("the Feature flags screen (an extension, UI-01 §26, §28)", () => {
  test("listed under Manage; the active flags by key; Archived holds the rest; search narrows", async () => {
    mount("/flags");
    await heading();
    const nav = screen.getByRole("navigation", { name: "Dashboard" });
    expect(within(nav).getByRole("link", { name: "Feature flags" }).getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(keys()).toEqual(["checkout-flow", "new-dashboard", "pricing-banner", "search-engine"]));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Archived/ }));
    await waitFor(() => expect(keys()).toEqual(["legacy-export"]));
    await user.click(screen.getByRole("button", { name: /^All flags/ }));
    await user.type(screen.getByRole("searchbox", { name: "Search flags" }), "search");
    await waitFor(() => expect(keys()).toEqual(["search-engine"]));
    await expectAccessible();
  });

  test("a flag's details: serving now, exposures by variant, targeting with who-gets-what, history, code", async () => {
    mount("/flags?flag=new-dashboard");
    await heading();
    const panel = await screen.findByRole("complementary", { name: /new-dashboard/ });
    expect(within(panel).getByText("on 25 % · off 75 %")).toBeDefined();
    await within(panel).findByRole("figure", { name: /Evaluations of new-dashboard/ });
    const user = userEvent.setup();
    await user.click(within(panel).getByRole("tab", { name: "Targeting" }));
    expect(within(panel).getByText(/If email ends with "@bunvex.dev", serve on/)).toBeDefined();
    // ada@bunvex.dev matches the staff rule
    expect(within(panel).getByText(/rule 1 matches/)).toBeDefined();
    await user.click(within(panel).getByRole("tab", { name: "History" }));
    await within(panel).findByText("Created with 2 variants");
    await user.click(within(panel).getByRole("tab", { name: "Code" }));
    expect(within(panel).getByText(/useFlag\("new-dashboard"\)/)).toBeDefined();
    await expectAccessible();
  });

  test("the kill switch asks first, then serves the off variant to everyone, in the history and the audit log", async () => {
    const { src } = mount("/flags?flag=new-dashboard");
    const panel = await screen.findByRole("complementary", { name: /new-dashboard/ });
    const user = userEvent.setup();
    await user.click(await within(panel).findByRole("button", { name: "Turn off" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Turn new-dashboard off for everyone?" });
    await user.click(within(dialog).getByRole("button", { name: "Turn off" }));
    await within(panel).findByText(/Off: everyone gets/);
    expect((await src.listFlags!()).find((f) => f.key === "new-dashboard")!.enabled).toBe(false);
    expect((await src.getFlagHistory!("new-dashboard"))[0]!.action).toBe("disabled");
    const audit = await src.listAuditEvents!({ numItems: 5, cursor: null });
    expect(audit.page[0]!.action).toBe("disable_feature_flag");
  });

  test("a flag's state is said as every status is: an icon and a word, not a solid pill (UX2-12)", async () => {
    mount("/flags");
    await heading();
    const badges = within(grid()).getAllByText(/^(On|Off|Archived)$/);
    expect(badges.length).toBeGreaterThan(0);
    for (const b of badges) expect(b.closest("[data-slot=status-badge]")).not.toBeNull();
  });

  test("a new flag: checked as it is typed, created, then open", async () => {
    const { src, history } = mount("/flags");
    await heading();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "New flag" })[0]!);
    const panel = await screen.findByRole("complementary", { name: "New flag" });
    const create = within(panel).getByRole("button", { name: "Create flag" });
    expect(create.hasAttribute("disabled")).toBe(true);
    await user.type(within(panel).getByLabelText("Key"), "Beta");
    expect(within(panel).getByText(/starts with a letter/)).toBeDefined();
    await user.clear(within(panel).getByLabelText("Key"));
    await user.type(within(panel).getByLabelText("Key"), "beta-search");
    await user.type(within(panel).getByLabelText("Name"), "Beta search");
    expect(create.hasAttribute("disabled")).toBe(false);
    await user.click(create);
    await waitFor(() => expect(new URLSearchParams(history.location.search).get("flag")).toBe("beta-search"));
    const saved = (await src.listFlags!()).find((f) => f.key === "beta-search")!;
    expect(saved.fallthrough).toEqual({
      rollout: [
        { variant: "on", weight: 10 },
        { variant: "off", weight: 90 },
      ],
    });
    expect(saved.enabled).toBe(false);
  });

  test("a read-only credential sees the flags but cannot change them", async () => {
    mount(
      "/flags?flag=new-dashboard",
      source({ capabilities: { operations: ["viewData", "writeData"], readOnly: true } }),
    );
    const panel = await screen.findByRole("complementary", { name: /new-dashboard/ });
    await within(panel).findByText("Serving now");
    expect(within(panel).queryByRole("button", { name: "Turn off" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New flag" })).toBeNull();
  });

  test("a source without flags: no sidebar entry, and the page says so", async () => {
    mount("/flags", source({ extensions: [] }));
    expect(await screen.findByText(/does not offer feature flags/)).toBeDefined();
    const nav = screen.getByRole("navigation", { name: "Dashboard" });
    expect(within(nav).queryByRole("link", { name: "Feature flags" })).toBeNull();
  });
});

// the extension's contract part, writes included, on the mock
describe("contract: feature flags", () => {
  flagsContract.describe({ make: () => source(), test, watchTimeoutMs: 2000, writes: true });
});

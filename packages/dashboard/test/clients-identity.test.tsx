// Who the clients are, on Authentication, Analytics and Feature flags (UI-01 §33.3).
import { describe, expect, test } from "bun:test";
import { Dashboard, type DashboardDataSource } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { sessionDevice } from "../src/auth/manage.tsx";
import { deviceOf } from "../src/extensions/analytics/mock.ts";
import { conditionText, evaluate, flagProblem } from "../src/extensions/flags/logic.ts";
import type { FeatureFlag } from "../src/extensions/flags/types.ts";
import { createRandom } from "../src/mock/random.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const source = () => new MockDataSource({ seed: 7, now: NOW, executions: 5 });
function mount(path: string, src = source()) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Dashboard dataSource={src} history={history} />);
  return src;
}

describe("a session's device", () => {
  test("said by its client, named by the registry; an agent when the client is unknown", () => {
    const apps = [
      {
        id: "a",
        name: "Shop iOS",
        platform: "ios" as const,
        identifiers: ["com.acme.shop"],
        createdAt: 0,
        lastSeen: null,
        versionsSeen: [],
      },
    ];
    const client = {
      platform: "ios" as const,
      sdk: { name: "bunvex-swift", version: "0.2.3" },
      app: { id: "com.acme.shop", version: "2.3.1" },
      runtime: "iOS 19.1",
      device: "iPhone 16",
    };
    expect(sessionDevice({ client, userAgent: null }, apps)).toBe("iPhone 16 · iOS 19.1 · Shop iOS 2.3.1");
    expect(sessionDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) Safari/605.1.15" })).toBe(
      "Safari on macOS",
    );
  });

  test("the user panel lists each session's device", async () => {
    const src = source();
    const sessions = await src.listAuthSessions({});
    const s = sessions.find((x) => x.client && x.client.platform !== "web")!;
    expect(s.userAgent).toContain(s.client!.sdk.name);
    mount(`/auth/users?user=${s.userId}`, src);
    const panel = await screen.findByRole("complementary");
    await waitFor(() => expect(within(panel).getAllByTestId("session-device").length).toBeGreaterThan(0));
    const shown = within(panel)
      .getAllByTestId("session-device")
      .map((d) => d.textContent);
    expect(shown.some((t) => t?.includes(s.client!.device!) && t.includes(s.client!.runtime!))).toBe(true);
    await expectAccessible();
  });
});

describe("Analytics from the clients", () => {
  test("an app's session: its device and system from the client; a browser's name from its runtime", () => {
    const rnd = createRandom(1);
    const ipad = deviceOf(
      { platform: "ios", sdk: { name: "s", version: "1" }, runtime: "iPadOS 19.1", device: "iPad Air" },
      rnd,
    );
    expect(ipad).toEqual({ device: "tablet", browser: "iOS app", os: "iPadOS" });
    const expo = deviceOf(
      { platform: "expo", sdk: { name: "s", version: "1" }, runtime: "Expo SDK 55 · Android 16", device: "Pixel 9" },
      rnd,
    );
    expect(expo).toEqual({ device: "mobile", browser: "Expo app", os: "Android" });
    expect(deviceOf({ platform: "web", sdk: { name: "s", version: "1" }, runtime: "Firefox 143" }, rnd).browser).toBe(
      "Firefox",
    );
  });

  test("the browsers breakdown has the apps too; a session's device is its client's", async () => {
    const src: DashboardDataSource = source();
    const r = await src.getAnalyticsRealtime!();
    expect(r.browsers.some((b) => b.name.endsWith(" app"))).toBe(true);
    expect(r.browsers.some((b) => b.name === "Chrome")).toBe(true);
    const sessions = (await src.listAnalyticsSessions!({ cursor: null, numItems: 50 })).page;
    expect(sessions.every((s) => s.client && s.client.platform !== "node" && s.client.platform !== "bun")).toBe(true);
  });
});

describe("Feature flags target the client", () => {
  const flag: Pick<FeatureFlag, "key" | "enabled" | "variants" | "offVariant" | "rules" | "fallthrough"> = {
    key: "f",
    enabled: true,
    variants: [
      { key: "on", value: true },
      { key: "off", value: false },
    ],
    offVariant: "off",
    fallthrough: { variant: "off" },
    rules: [
      {
        id: "r",
        conditions: [
          { attribute: "platform", operator: "in", values: ["ios", "android"] },
          { attribute: "appVersion", operator: "versionAtLeast", values: ["2.3.0"] },
        ],
        serve: { variant: "on" },
      },
    ],
  };

  test("by platform and app version, compared by number", () => {
    const get = (platform: string, appVersion?: string) => evaluate(flag, { platform, appVersion }).variant;
    expect(get("ios", "2.3.0")).toBe("on");
    expect(get("android", "2.10.0")).toBe("on");
    expect(get("ios", "2.2.9")).toBe("off");
    expect(get("ios", "2.3.0-beta.1")).toBe("on");
    expect(get("web", "2.4.0")).toBe("off");
    expect(get("ios")).toBe("off");
    expect(get("ios", "latest")).toBe("off");
    const below = { attribute: "appVersion", operator: "versionBelow" as const, values: ["2.0"] };
    expect(
      evaluate(
        { ...flag, rules: [{ id: "b", conditions: [below], serve: { variant: "on" } }] },
        { appVersion: "1.9.9" },
      ).variant,
    ).toBe("on");
    expect(conditionText(below)).toBe('appVersion is below version "2.0"');
  });

  test("a version rule needs a version", () => {
    const f = {
      key: "f",
      name: "F",
      type: "boolean" as const,
      enabled: true,
      variants: flag.variants,
      offVariant: "off",
      fallthrough: flag.fallthrough,
      rules: [
        {
          id: "r",
          conditions: [{ attribute: "appVersion", operator: "versionAtLeast" as const, values: ["two"] }],
          serve: { variant: "on" },
        },
      ],
    };
    expect(flagProblem(f)).toBe('Rule 1 compares appVersion with "two", which is not a version.');
    f.rules[0]!.conditions[0]!.values = ["2.3"];
    expect(flagProblem(f)).toBeUndefined();
  });

  test("the mock's checkout test sends new app builds to express; the rule reads in words", async () => {
    mount("/flags?flag=checkout-flow");
    const panel = await screen.findByRole("complementary", { name: /checkout-flow/ });
    await userEvent.setup().click(within(panel).getByRole("tab", { name: "Targeting" }));
    expect(
      within(panel).getByText(/platform is one of "ios", "android" and appVersion is at least version "2.3.0"/),
    ).toBeDefined();
    // the preview's identity carries a platform and an app version: an iOS 2.3.1 build matches
    expect(within(panel).getByText(/rule 1 matches/)).toBeDefined();
    await expectAccessible();
  });
});

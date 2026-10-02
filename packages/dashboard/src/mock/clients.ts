// The mock's clients (UI-01 §33): a fixed population of who connects — a web app, its iOS and Android builds,
// a staff app on Expo nobody registered, Node workers and a Bun script — with a few SDKs past the policy, so
// the views have something to warn about. The same population feeds the topology's connections, log lines,
// sessions and analytics, so they agree. Registering an app re-labels its clients at once. Not part of the
// contract: the source wraps it.
import {
  appOf,
  type ClientApp,
  type ClientAppInput,
  type ClientBucket,
  type ClientInfo,
  type ClientPlatform,
  type ClientPolicy,
  type ClientSummary,
  sdkState,
} from "../data-source-clients.ts";
import type { Random } from "./random.ts";

type Segment = {
  platform: ClientPlatform;
  sdk: string;
  sdkVersion: string;
  /** The app's id as the client says it (a bundle id, a package name, an origin); absent for a script. */
  appId?: string;
  appVersion?: string;
  build?: string;
  runtimes: string[];
  devices?: string[];
  environment?: ClientInfo["environment"];
  /** Share of the connections. */
  weight: number;
};

const WEB = "https://shop.acme.test";
const SHOP = "com.acme.shop";
const STAFF = "com.acme.staff";
const BROWSERS = ["Chrome 141", "Safari 26", "Firefox 143", "Edge 141"];

const SEGMENTS: Segment[] = [
  {
    platform: "web",
    sdk: "@bunvex/client",
    sdkVersion: "0.4.2",
    appId: WEB,
    appVersion: "2026.10.1",
    runtimes: BROWSERS,
    weight: 30,
  },
  {
    platform: "web",
    sdk: "@bunvex/client",
    sdkVersion: "0.4.1",
    appId: WEB,
    appVersion: "2026.09.24",
    runtimes: BROWSERS,
    weight: 8,
  },
  {
    platform: "ios",
    sdk: "bunvex-swift",
    sdkVersion: "0.2.3",
    appId: SHOP,
    appVersion: "2.3.1",
    build: "481",
    runtimes: ["iOS 19.1", "iOS 19.0", "iPadOS 19.1"],
    devices: ["iPhone 16", "iPhone 15 Pro", "iPad Air"],
    weight: 14,
  },
  {
    platform: "ios",
    sdk: "bunvex-swift",
    sdkVersion: "0.2.3",
    appId: SHOP,
    appVersion: "2.3.0",
    build: "470",
    runtimes: ["iOS 18.6", "iOS 19.0"],
    devices: ["iPhone 14", "iPhone 16"],
    weight: 5,
  },
  {
    platform: "ios",
    sdk: "bunvex-swift",
    sdkVersion: "0.1.9",
    appId: SHOP,
    appVersion: "2.1.4",
    build: "402",
    runtimes: ["iOS 17.7"],
    devices: ["iPhone 12"],
    weight: 2,
  },
  {
    platform: "android",
    sdk: "bunvex-kotlin",
    sdkVersion: "0.2.1",
    appId: SHOP,
    appVersion: "2.3.1",
    build: "1081",
    runtimes: ["Android 16", "Android 15"],
    devices: ["Pixel 9", "Galaxy S25", "Pixel 8a"],
    weight: 12,
  },
  {
    platform: "android",
    sdk: "bunvex-kotlin",
    sdkVersion: "0.1.5",
    appId: SHOP,
    appVersion: "2.0.2",
    build: "990",
    runtimes: ["Android 13"],
    devices: ["Galaxy A54"],
    weight: 2,
  },
  {
    platform: "expo",
    sdk: "@bunvex/client",
    sdkVersion: "0.4.2",
    appId: STAFF,
    appVersion: "1.4.0",
    runtimes: ["Expo SDK 55 · iOS 19.1", "Expo SDK 55 · Android 16"],
    devices: ["iPhone 16", "Pixel 9"],
    weight: 5,
  },
  {
    platform: "node",
    sdk: "@bunvex/client",
    sdkVersion: "0.3.8",
    runtimes: ["Node 24.1"],
    environment: "production",
    weight: 3,
  },
  {
    platform: "bun",
    sdk: "@bunvex/client",
    sdkVersion: "0.4.2",
    runtimes: ["Bun 1.4.2"],
    environment: "development",
    weight: 2,
  },
];

const POLICY: ClientPolicy = {
  web: { upgradeBelow: "0.4.0", unsupportedBelow: "0.3.0" },
  "react-native": { upgradeBelow: "0.4.0", unsupportedBelow: "0.3.0" },
  expo: { upgradeBelow: "0.4.0", unsupportedBelow: "0.3.0" },
  node: { upgradeBelow: "0.4.0", unsupportedBelow: "0.3.0" },
  bun: { upgradeBelow: "0.4.0", unsupportedBelow: "0.3.0" },
  deno: { upgradeBelow: "0.4.0", unsupportedBelow: "0.3.0" },
  ios: { upgradeBelow: "0.2.0", unsupportedBelow: "0.1.0" },
  swift: { upgradeBelow: "0.2.0", unsupportedBelow: "0.1.0" },
  android: { upgradeBelow: "0.2.0", unsupportedBelow: "0.1.6" },
  kotlin: { upgradeBelow: "0.2.0", unsupportedBelow: "0.1.6" },
};

/** Split `total` by `weights`, whole numbers that add up (largest remainder). */
function split(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]!++;
    left--;
  }
  return out;
}

export class MockClients {
  readonly policy: ClientPolicy = structuredClone(POLICY);
  private apps: ClientApp[];
  private seq = 0;

  constructor(private readonly now: () => number) {
    const t = now();
    const app = (name: string, platform: ClientPlatform, identifiers: string[], colour: string, days: number) => ({
      id: `app${++this.seq}`,
      name,
      platform,
      identifiers,
      colour,
      createdAt: t - days * 86_400_000,
      lastSeen: null,
      versionsSeen: [],
    });
    // the Expo staff app, the workers and the script are left unregistered: connecting needs no registration
    this.apps = [
      app("Shop Web", "web", [WEB], "info", 60),
      app("Shop iOS", "ios", [SHOP], "success", 45),
      app("Shop Android", "android", [SHOP], "warning", 45),
    ];
  }

  /**
   * A node's connections split by platform, app and SDK version. The shares tilt a little per node (`salt`),
   * deterministically, so a node keeps its mix from one picture to the next.
   */
  buckets(connections: number, salt: number): ClientBucket[] {
    const weights = SEGMENTS.map((s, k) => s.weight * (1 + 0.25 * Math.sin(salt * 1.7 + k)));
    const counts = split(connections, weights);
    const merged = new Map<string, ClientBucket>();
    SEGMENTS.forEach((s, k) => {
      const n = counts[k]!;
      if (n === 0) return;
      const app = appOf({ platform: s.platform, app: { id: s.appId } }, this.apps)?.id ?? null;
      const key = [s.platform, app, s.sdkVersion, s.appVersion].join("|");
      const b = merged.get(key);
      if (b) b.connections += n;
      else
        merged.set(key, {
          platform: s.platform,
          app,
          sdkVersion: s.sdkVersion,
          ...(s.appVersion && { appVersion: s.appVersion }),
          connections: n,
        });
    });
    return [...merged.values()].sort((a, b) => b.connections - a.connections);
  }

  /** One client, drawn by weight: who made a call, owns a session, opened a page. */
  pick(rnd: Random): ClientInfo {
    const total = SEGMENTS.reduce((a, s) => a + s.weight, 0);
    const at = rnd.next() * total;
    let acc = 0;
    const s =
      SEGMENTS.find((x) => {
        acc += x.weight;
        return at < acc;
      }) ?? SEGMENTS[0]!;
    return {
      platform: s.platform,
      sdk: { name: s.sdk, version: s.sdkVersion },
      ...(s.appId && {
        app: { id: s.appId, ...(s.appVersion && { version: s.appVersion }), ...(s.build && { build: s.build }) },
      }),
      runtime: rnd.pick(s.runtimes),
      ...(s.devices && { device: rnd.pick(s.devices) }),
      ...(s.environment && { environment: s.environment }),
    };
  }

  summary(all: ClientBucket[]): ClientSummary {
    const byPlatform = new Map<ClientPlatform, number>();
    const versions = new Map<string, ClientSummary["sdkVersions"][number]>();
    const sdkOf = (p: ClientPlatform, v: string) =>
      SEGMENTS.find((s) => s.platform === p && s.sdkVersion === v)?.sdk ?? "@bunvex/client";
    for (const b of all) {
      byPlatform.set(b.platform, (byPlatform.get(b.platform) ?? 0) + b.connections);
      const key = `${b.platform}|${b.sdkVersion}`;
      const v = versions.get(key);
      if (v) v.connections += b.connections;
      else
        versions.set(key, {
          platform: b.platform,
          sdk: sdkOf(b.platform, b.sdkVersion),
          version: b.sdkVersion,
          connections: b.connections,
          state: sdkState(b.platform, b.sdkVersion, this.policy),
        });
    }
    return {
      time: this.now(),
      connections: all.reduce((a, b) => a + b.connections, 0),
      byPlatform: [...byPlatform]
        .map(([platform, connections]) => ({ platform, connections }))
        .sort((a, b) => b.connections - a.connections),
      sdkVersions: [...versions.values()].sort((a, b) => b.connections - a.connections),
      policy: structuredClone(this.policy),
    };
  }

  /** The registry, with what the live buckets say about each app. */
  list(all: ClientBucket[]): ClientApp[] {
    return this.apps.map((a) => {
      const mine = all.filter((b) => b.app === a.id);
      const seen = new Map<string, number>();
      for (const b of mine) if (b.appVersion) seen.set(b.appVersion, (seen.get(b.appVersion) ?? 0) + b.connections);
      if (mine.length) a.lastSeen = this.now();
      return {
        ...structuredClone(a),
        versionsSeen: [...seen]
          .map(([version, connections]) => ({ version, connections }))
          .sort((x, y) => y.connections - x.connections),
      };
    });
  }

  create(input: ClientAppInput): ClientApp {
    const app: ClientApp = {
      id: `app${++this.seq}`,
      name: input.name,
      platform: input.platform,
      identifiers: [...input.identifiers],
      ...(input.colour && { colour: input.colour }),
      ...(input.notes && { notes: input.notes }),
      createdAt: this.now(),
      lastSeen: null,
      versionsSeen: [],
    };
    this.apps.push(app);
    return structuredClone(app);
  }

  update(id: string, patch: Partial<ClientAppInput>): ClientApp | undefined {
    const app = this.apps.find((a) => a.id === id);
    if (!app) return undefined;
    Object.assign(app, structuredClone(patch));
    return structuredClone(app);
  }

  remove(id: string): boolean {
    const before = this.apps.length;
    this.apps = this.apps.filter((a) => a.id !== id);
    return this.apps.length < before;
  }

  /** The registry as it stands (for a session's or a log line's app name). */
  registered(): ClientApp[] {
    return this.apps;
  }
}

// Who the clients are, in the dashboard contract (UI-01 §33, STUDY-12 §21) — a bunvex addition. Every client
// says what it is when it connects: its platform, its SDK and version, and, when the SDK knows them, the app's
// id, version and build, its runtime and environment. Connecting stays open: nothing has to be registered.
// An optional registry of apps names them ("Shop iOS" for `com.acme.shop` on iOS), and a policy says which
// SDK versions are old (Convex's `ClientVersionState`: upgrade required, unsupported). Today only the mock
// reports any of it: the handshake and `@bunvex/client` are a later study. Every method is optional, detected
// with `typeof`; reads need `viewMetrics`, the registry's writes `writeData`. Re-exported by `data-source.ts`.
import type { CallOptions } from "./data-source.ts";

export type ClientPlatform =
  | "web"
  | "ios"
  | "android"
  | "react-native"
  | "expo"
  | "node"
  | "bun"
  | "deno"
  | "swift"
  | "kotlin"
  | "other";

export const CLIENT_PLATFORMS: readonly ClientPlatform[] = [
  "web",
  "ios",
  "android",
  "react-native",
  "expo",
  "node",
  "bun",
  "deno",
  "swift",
  "kotlin",
  "other",
];

/** What a client says about itself when it connects. */
export type ClientInfo = {
  platform: ClientPlatform;
  /** The SDK, e.g. `{ name: "@bunvex/client", version: "0.4.2" }`. */
  sdk: { name: string; version: string };
  /** The app, when the SDK can tell: a bundle id, a package name or a web origin; its version and build. */
  app?: { id?: string; version?: string; build?: string };
  /** e.g. "Chrome 141", "iOS 19.1", "Bun 1.4.2". */
  runtime?: string;
  /** A device's model, when the SDK can tell (e.g. "iPhone 16", "Pixel 9"). */
  device?: string;
  environment?: "development" | "production";
};

/** How old an SDK version is, as Convex says it (`ClientVersionState`). */
export type SdkState = "supported" | "upgrade" | "unsupported";

/** A share of a node's connections: one platform, one app (registered, or not), one SDK version. */
export type ClientBucket = {
  platform: ClientPlatform;
  /** The registered app these clients belong to, or `null` when no app matches them. */
  app: string | null;
  sdkVersion: string;
  /** The app's version, when the clients say it. */
  appVersion?: string;
  connections: number;
};

/** A registered app (optional): how the dashboard names a set of clients. */
export type ClientApp = {
  id: string;
  name: string;
  platform: ClientPlatform;
  /** What a client's `app.id` is matched against: a bundle id, a package name, a web origin. */
  identifiers: string[];
  /** A token colour name for its mark ("info", "success"…), when set. */
  colour?: string;
  notes?: string;
  createdAt: number;
  /** When a client of this app last connected (`null`: never). */
  lastSeen: number | null;
  /** The app versions its clients reported recently, with how many connections each, most first. */
  versionsSeen: { version: string; connections: number }[];
};

export type ClientAppInput = Pick<ClientApp, "name" | "platform" | "identifiers"> &
  Partial<Pick<ClientApp, "colour" | "notes">>;

/** Per platform, the SDK versions below which clients are told to upgrade, or refused (semver). */
export type ClientPolicy = Partial<Record<ClientPlatform, { upgradeBelow?: string; unsupportedBelow?: string }>>;

/** The live clients at a glance, across every node. */
export type ClientSummary = {
  time: number;
  connections: number;
  byPlatform: { platform: ClientPlatform; connections: number }[];
  /** Every SDK version in use, per platform, with its state under the policy, most connections first. */
  sdkVersions: { platform: ClientPlatform; sdk: string; version: string; connections: number; state: SdkState }[];
  policy: ClientPolicy;
};

export interface ClientsFeatures {
  getClientSummary?(opts?: CallOptions): Promise<ClientSummary>;
  listClientApps?(opts?: CallOptions): Promise<ClientApp[]>;
  createClientApp?(app: ClientAppInput, opts?: CallOptions): Promise<ClientApp>;
  updateClientApp?(id: string, patch: Partial<ClientAppInput>, opts?: CallOptions): Promise<ClientApp>;
  deleteClientApp?(id: string, opts?: CallOptions): Promise<void>;
}

// ------------------------------------------------------------------ shared logic

/** Compares two dotted versions ("2.10.0" > "2.9.3"); missing parts count as 0, a pre-release suffix is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[-+]/)[0]!
      .split(".")
      .map((p) => Number.parseInt(p, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function sdkState(platform: ClientPlatform, version: string, policy: ClientPolicy): SdkState {
  const p = policy[platform];
  if (p?.unsupportedBelow && compareVersions(version, p.unsupportedBelow) < 0) return "unsupported";
  if (p?.upgradeBelow && compareVersions(version, p.upgradeBelow) < 0) return "upgrade";
  return "supported";
}

/** The registered app a client belongs to: same platform, and its `app.id` among the app's identifiers. */
export function appOf(client: Pick<ClientInfo, "platform" | "app">, apps: ClientApp[]): ClientApp | undefined {
  const id = client.app?.id;
  if (!id) return undefined;
  return apps.find((a) => a.platform === client.platform && a.identifiers.includes(id));
}

// The Analytics extension's part of the dashboard contract (UI-01 §26, STUDY-12 §16) — a bunvex addition:
// Convex has no analytics. Live visitors are the deployment's open WebSocket sessions (bunvex knows them: every
// client holds one), placed by a server-side GeoIP lookup; events come from a client `track()` helper (page
// views by default). Both are future server work: today only the mock feeds this. Every method is optional — a
// source offers Analytics by having them (detected with `typeof`) — and needs the `viewMetrics` operation.
import type { CallOptions, DataSourceError, Page, Unsubscribe, Value } from "../../data-source.ts";
import type { ClientInfo } from "../../data-source-clients.ts";

export type Device = "desktop" | "mobile" | "tablet";
export const DEVICES: readonly Device[] = ["desktop", "mobile", "tablet"];

/** Where a session comes from, from its IP (server-side GeoIP). */
export type Place = {
  country: string;
  /** ISO 3166-1 alpha-2. */
  countryCode: string;
  city: string | null;
  lat: number;
  lon: number;
};

/** A session with an open WebSocket right now. */
export type LiveVisitor = Place & {
  sessionId: string;
  /** The signed-in user (the auth identity's subject), when there is one. */
  profileId: string | null;
  device: Device;
  browser: string;
  path: string;
  referrer: string | null;
  /** When the session started and when it last sent something (wall-clock ms). */
  since: number;
  lastSeen: number;
};

export type AnalyticsEvent = {
  id: string;
  time: number;
  /** "page_view", or the name given to `track()`. */
  name: string;
  path: string;
  sessionId: string;
  profileId: string | null;
  country: string;
  city: string | null;
  device: Device;
  browser: string;
  referrer: string | null;
  properties: Record<string, Value>;
};

/** One row of a breakdown: visitors are distinct sessions, events all events, over the last 30 minutes. */
export type BreakdownRow = { name: string; visitors: number; events: number };

export type AnalyticsRealtime = {
  /** When this picture was taken. */
  time: number;
  live: LiveVisitor[];
  /** Distinct sessions seen in the last 30 minutes, and per minute (30 values, oldest first). */
  visitorsLast30Min: number;
  perMinute: number[];
  /** Visitors in the last 30 minutes by device. */
  devices: Record<Device, number>;
  pages: BreakdownRow[];
  referrers: BreakdownRow[];
  countries: (BreakdownRow & { countryCode: string })[];
  browsers: BreakdownRow[];
  /** The newest events, newest first (at most 50). */
  recent: AnalyticsEvent[];
};

export type AnalyticsSession = Place & {
  id: string;
  profileId: string | null;
  startedAt: number;
  lastSeen: number;
  events: number;
  pageViews: number;
  device: Device;
  browser: string;
  os: string;
  /** What the session's client said when it connected (UI-01 §33); its device, browser and os come from it. */
  client?: ClientInfo;
  referrer: string | null;
  entryPath: string;
  exitPath: string;
  /** Its WebSocket is open now. */
  live: boolean;
};

export type AnalyticsProfile = {
  id: string;
  name: string | null;
  email: string | null;
  firstSeen: number;
  lastSeen: number;
  sessions: number;
  events: number;
  country: string;
  device: Device;
};

export type AnalyticsQuery = {
  cursor: string | null;
  numItems: number;
  /** Text in the name, path, country or city (events, sessions) or in the name or email (profiles). */
  q?: string;
  /** Events only: one event name. */
  name?: string;
  /** Events and sessions only: one profile. */
  profileId?: string;
};

export interface AnalyticsFeatures {
  getAnalyticsRealtime?(opts?: CallOptions): Promise<AnalyticsRealtime>;
  /** Pushes a fresh picture whenever the source has one. Never synchronously. */
  watchAnalyticsRealtime?(
    onRealtime: (r: AnalyticsRealtime) => void,
    onError: (error: DataSourceError) => void,
  ): Unsubscribe;
  /** Newest first. */
  listAnalyticsEvents?(query: AnalyticsQuery, opts?: CallOptions): Promise<Page<AnalyticsEvent>>;
  /** Newest (last seen) first. */
  listAnalyticsSessions?(query: AnalyticsQuery, opts?: CallOptions): Promise<Page<AnalyticsSession>>;
  /** Most recently seen first. */
  listAnalyticsProfiles?(query: AnalyticsQuery, opts?: CallOptions): Promise<Page<AnalyticsProfile>>;
}

// The Analytics extension's mock (UI-01 §26): sessions spread over the last 30 days from weighted cities, each
// with page views and a few custom events, and a live set that moves — `step(ms)` brings new visitors, lets
// some leave and adds events to the ones still here. Deterministic for a seed; time is the mock's own clock.
import type { Page, Value } from "../../data-source.ts";
import type { Random } from "../../mock/random.ts";
import type {
  AnalyticsEvent,
  AnalyticsProfile,
  AnalyticsQuery,
  AnalyticsRealtime,
  AnalyticsSession,
  BreakdownRow,
  Device,
  LiveVisitor,
} from "./data-source.ts";
import { PLACES } from "./places.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const LIVE_FOR = 2 * MIN; // a session is live while it sent something in the last 2 minutes
const PATHS = [
  "/",
  "/pricing",
  "/docs",
  "/docs/quickstart",
  "/docs/queries",
  "/blog",
  "/blog/realtime-apps",
  "/changelog",
  "/dashboard",
  "/settings",
];
const REFERRERS = [
  null,
  null,
  "google.com",
  "github.com",
  "x.com",
  "news.ycombinator.com",
  "reddit.com",
  "duckduckgo.com",
];
const BROWSERS = ["Chrome", "Chrome", "Chrome", "Safari", "Safari", "Firefox", "Edge"];
const OS: Record<Device, string[]> = {
  desktop: ["macOS", "Windows", "Linux"],
  mobile: ["iOS", "Android"],
  tablet: ["iPadOS", "Android"],
};
const CUSTOM = ["sign_up", "add_to_cart", "start_trial", "invite_sent", "search"];
const FIRST = ["Ada", "Alan", "Grace", "Linus", "Margaret", "Barbara", "Ken", "Radia", "Frances", "Edsger"];
const LAST = [
  "Lovelace",
  "Turing",
  "Hopper",
  "Torvalds",
  "Hamilton",
  "Liskov",
  "Thompson",
  "Perlman",
  "Allen",
  "Dijkstra",
];

type Session = AnalyticsSession;

const pickWeighted = (rnd: Random) => {
  const total = PLACES.reduce((n, p) => n + p.weight, 0);
  let r = rnd.next() * total;
  for (const p of PLACES) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return PLACES[0]!;
};

const page = <T>(rows: T[], q: AnalyticsQuery): Page<T> => {
  const start = q.cursor ? Number(q.cursor) : 0;
  const end = start + q.numItems;
  return { page: structuredClone(rows.slice(start, end)), isDone: end >= rows.length, continueCursor: String(end) };
};

export class MockAnalytics {
  private clock: number;
  private readonly profiles: AnalyticsProfile[] = [];
  private readonly sessions: Session[] = [];
  private readonly events: AnalyticsEvent[] = []; // oldest first
  private seq = 0;

  constructor(
    private readonly rnd: Random,
    now: number,
  ) {
    this.clock = now;
    for (let i = 0; i < 240; i++) {
      const identified = rnd.chance(0.45);
      const first = rnd.pick(FIRST);
      const last = rnd.pick(LAST);
      this.profiles.push({
        id: `p_${rnd.id().slice(0, 10)}`,
        name: identified ? `${first} ${last}` : null,
        email: identified ? `${first}.${last}${i}@example.com`.toLowerCase() : null,
        firstSeen: now,
        lastSeen: 0,
        sessions: 0,
        events: 0,
        country: "",
        device: "desktop",
      });
    }
    // history: the last 30 days, denser recently
    for (let i = 0; i < 900; i++) {
      const ago = Math.floor(rnd.next() ** 2 * 30 * DAY) + 3 * MIN;
      this.startSession(now - ago, rnd.int(1, 9));
    }
    // the live set: sessions active in the last minutes
    for (let i = 0; i < 70; i++) this.startSession(now - rnd.int(0, 25) * MIN, rnd.int(1, 6), true);
    this.events.sort((a, b) => a.time - b.time);
  }

  private startSession(at: number, views: number, keepAlive = false) {
    const rnd = this.rnd;
    const place = pickWeighted(rnd);
    const device: Device = rnd.chance(0.6) ? "desktop" : rnd.chance(0.85) ? "mobile" : "tablet";
    const profile = rnd.chance(0.7) ? rnd.pick(this.profiles) : null;
    const s: Session = {
      id: `s_${rnd.id().slice(0, 12)}`,
      profileId: profile?.id ?? null,
      startedAt: at,
      lastSeen: at,
      events: 0,
      pageViews: 0,
      device,
      browser: rnd.pick(BROWSERS),
      os: rnd.pick(OS[device]),
      referrer: rnd.pick(REFERRERS),
      entryPath: rnd.pick(PATHS),
      exitPath: "/",
      live: false,
      city: place.city,
      country: place.country,
      countryCode: place.countryCode,
      // a little jitter so visitors of one city don't sit on one pixel
      lat: place.lat + (rnd.next() - 0.5) * 0.6,
      lon: place.lon + (rnd.next() - 0.5) * 0.6,
    };
    this.sessions.push(s);
    let t = at;
    let path = s.entryPath;
    for (let v = 0; v < views && t <= this.clock; v++) {
      this.emit(s, "page_view", path, t);
      if (rnd.chance(0.25)) this.emit(s, rnd.pick(CUSTOM), path, Math.min(t + 2_000, this.clock));
      t += rnd.int(10, 120) * 1000;
      path = rnd.pick(PATHS);
    }
    if (keepAlive) s.lastSeen = Math.max(s.lastSeen, this.clock - rnd.int(0, 90) * 1000);
    if (profile) {
      profile.sessions++;
      profile.firstSeen = Math.min(profile.firstSeen, at);
      profile.lastSeen = Math.max(profile.lastSeen, s.lastSeen);
      profile.country = place.country;
      profile.device = device;
    }
    return s;
  }

  private emit(s: Session, name: string, path: string, time: number) {
    const properties: Record<string, Value> =
      name === "page_view" ? { title: path === "/" ? "Home" : path } : { plan: this.rnd.pick(["free", "pro", "team"]) };
    const e: AnalyticsEvent = {
      id: `e_${(++this.seq).toString(36)}`,
      time,
      name,
      path,
      sessionId: s.id,
      profileId: s.profileId,
      country: s.country,
      city: s.city,
      device: s.device,
      browser: s.browser,
      referrer: s.referrer,
      properties,
    };
    this.events.push(e);
    s.events++;
    if (name === "page_view") s.pageViews++;
    s.exitPath = path;
    s.lastSeen = Math.max(s.lastSeen, time);
    const p = s.profileId ? this.profiles.find((x) => x.id === s.profileId) : undefined;
    if (p) {
      p.events++;
      p.lastSeen = Math.max(p.lastSeen, time);
    }
  }

  private isLive = (s: Session) => this.clock - s.lastSeen <= LIVE_FOR;

  /** Moves the mock's clock: a few arrivals, some departures (they go quiet), events from the visitors here. */
  step(ms: number) {
    this.clock += ms;
    const rnd = this.rnd;
    const arrivals = rnd.int(0, 3);
    for (let i = 0; i < arrivals; i++) this.startSession(this.clock - rnd.int(0, ms), 1);
    for (const s of this.sessions) {
      if (!this.isLive(s)) continue;
      if (rnd.chance(0.12)) continue; // quiet this step; two quiet minutes and it is gone
      if (rnd.chance(0.35))
        this.emit(s, rnd.chance(0.8) ? "page_view" : rnd.pick(CUSTOM), rnd.pick(PATHS), this.clock - rnd.int(0, ms));
    }
  }

  realtime(): AnalyticsRealtime {
    const now = this.clock;
    const since = now - 30 * MIN;
    const recentEvents = this.events.filter((e) => e.time > since && e.time <= now);
    const sessionsById = new Map(this.sessions.map((s) => [s.id, s]));
    const visitors = new Set(recentEvents.map((e) => e.sessionId));
    const perMinute = Array.from({ length: 30 }, (_, i) => {
      const from = since + i * MIN;
      return new Set(recentEvents.filter((e) => e.time > from && e.time <= from + MIN).map((e) => e.sessionId)).size;
    });
    const devices: Record<Device, number> = { desktop: 0, mobile: 0, tablet: 0 };
    for (const id of visitors) devices[sessionsById.get(id)!.device]++;
    const breakdown = (key: (e: AnalyticsEvent) => string | null): BreakdownRow[] => {
      const rows = new Map<string, { visitors: Set<string>; events: number }>();
      for (const e of recentEvents) {
        const k = key(e) ?? "(direct)";
        const r = rows.get(k) ?? { visitors: new Set(), events: 0 };
        r.visitors.add(e.sessionId);
        r.events++;
        rows.set(k, r);
      }
      return [...rows]
        .map(([name, r]) => ({ name, visitors: r.visitors.size, events: r.events }))
        .sort((a, b) => b.visitors - a.visitors || b.events - a.events || a.name.localeCompare(b.name))
        .slice(0, 8);
    };
    const code = new Map(PLACES.map((p) => [p.country, p.countryCode]));
    const live: LiveVisitor[] = this.sessions.filter(this.isLive).map((s) => ({
      sessionId: s.id,
      profileId: s.profileId,
      device: s.device,
      browser: s.browser,
      path: s.exitPath,
      referrer: s.referrer,
      since: s.startedAt,
      lastSeen: s.lastSeen,
      country: s.country,
      countryCode: s.countryCode,
      city: s.city,
      lat: s.lat,
      lon: s.lon,
    }));
    return {
      time: now,
      live,
      visitorsLast30Min: visitors.size,
      perMinute,
      devices,
      pages: breakdown((e) => (e.name === "page_view" ? e.path : null)).filter((r) => r.name !== "(direct)"),
      referrers: breakdown((e) => e.referrer),
      countries: breakdown((e) => e.country).map((r) => ({ ...r, countryCode: code.get(r.name) ?? "" })),
      browsers: breakdown((e) => e.browser),
      recent: structuredClone(recentEvents.slice(-50).reverse()),
    };
  }

  listEvents(q: AnalyticsQuery): Page<AnalyticsEvent> {
    const text = q.q?.trim().toLowerCase();
    const rows = this.events
      .filter((e) => e.time <= this.clock)
      .filter((e) => (q.name ? e.name === q.name : true))
      .filter((e) => (q.profileId ? e.profileId === q.profileId : true))
      .filter((e) => !text || [e.name, e.path, e.country, e.city ?? ""].some((s) => s.toLowerCase().includes(text)))
      .reverse();
    return page(rows, q);
  }

  listSessions(q: AnalyticsQuery): Page<AnalyticsSession> {
    const text = q.q?.trim().toLowerCase();
    const rows = this.sessions
      .filter((s) => s.startedAt <= this.clock)
      .filter((s) => (q.profileId ? s.profileId === q.profileId : true))
      .filter(
        (s) =>
          !text ||
          [s.entryPath, s.exitPath, s.country, s.city ?? "", s.browser].some((x) => x.toLowerCase().includes(text)),
      )
      .map((s) => ({ ...s, live: this.isLive(s) }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
    return page(rows, q);
  }

  listProfiles(q: AnalyticsQuery): Page<AnalyticsProfile> {
    const text = q.q?.trim().toLowerCase();
    const rows = this.profiles
      .filter((p) => p.sessions > 0)
      .filter((p) => !text || [p.name ?? "", p.email ?? "", p.id].some((x) => x.toLowerCase().includes(text)))
      .sort((a, b) => b.lastSeen - a.lastSeen);
    return page(rows, q);
  }
}

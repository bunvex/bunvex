// The mock's authentication admin (UI-01 §25, STUDY-12 §7.8): an app's users with their providers, sessions,
// organizations, the auth configuration and its audit log, in better-auth's terms. Pure state, from its own
// random stream (adding it moves no other sample); MockDataSource wraps it in its latency and gates.
import {
  type AuthConfig,
  type AuthEmailAction,
  type AuthEvent,
  type AuthInvitation,
  type AuthMember,
  type AuthMemberRole,
  type AuthOrganization,
  type AuthProviderId,
  type AuthSession,
  type AuthUser,
  type AuthUserQuery,
  DataSourceError,
  type Json,
  type Page,
  userStatus,
} from "../data-source.ts";
import { createRandom, type Random } from "./random.ts";

const FIRST = [
  "Ada",
  "Grace",
  "Linus",
  "Margaret",
  "Alan",
  "Barbara",
  "Ken",
  "Radia",
  "Tim",
  "Frances",
  "Edsger",
  "Hedy",
];
const LAST = ["Lovelace", "Hopper", "Torvalds", "Hamilton", "Turing", "Liskov", "Thompson", "Perlman", "Lee", "Allen"];
const AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) AppleWebKit/605.1.15 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Mobile/15E148",
];
const DAY = 86_400_000;

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  providers: [
    { id: "email-password", enabled: true },
    { id: "magic-link", enabled: true },
    { id: "google", enabled: true, clientId: "1234-web.apps.googleusercontent.com" },
    { id: "github", enabled: true, clientId: "Iv1.8a61f9b3a7aba766" },
    { id: "apple", enabled: false },
    { id: "microsoft", enabled: false },
    { id: "passkey", enabled: true },
  ],
  multiFactor: { totp: true, otpEmail: false, backupCodes: true, required: "admins" },
  passkeys: { enabled: true, rpName: "Acme", rpId: "acme.dev" },
  sessions: { expiresInSeconds: 7 * 86_400, updateAgeSeconds: 86_400, freshAgeSeconds: 300 },
  rateLimits: { enabled: true, windowSeconds: 60, max: 100 },
  urls: { siteUrl: "https://acme.dev", redirectAllowList: ["https://acme.dev/*", "http://localhost:5173/*"] },
  emails: {
    "verify-email": { subject: "Verify your email", body: "Hi {{name}}, confirm your address: {{url}}" },
    "password-reset": { subject: "Reset your password", body: "Hi {{name}}, choose a new password: {{url}}" },
    "magic-link": { subject: "Your sign-in link", body: "Sign in to Acme: {{url}}" },
    invitation: { subject: "You are invited to Acme", body: "{{inviter}} invited you to {{organization}}: {{url}}" },
  },
};

export class MockAuthAdmin {
  private users: AuthUser[] = [];
  private sessions: AuthSession[] = [];
  private orgs: AuthOrganization[] = [];
  private members: AuthMember[] = [];
  private invitations: AuthInvitation[] = [];
  private events: AuthEvent[] = [];
  private config: AuthConfig = structuredClone(DEFAULT_AUTH_CONFIG);
  private readonly rnd: Random;

  constructor(
    seed: number,
    private readonly now: () => number,
    users = 40,
  ) {
    this.rnd = createRandom(seed ^ 0xa17);
    const t0 = now();
    for (let i = 0; i < users; i++) {
      const first = this.rnd.pick(FIRST);
      const last = this.rnd.pick(LAST);
      const createdAt = t0 - this.rnd.int(1, 300) * DAY + this.rnd.int(0, DAY);
      const providers: AuthProviderId[] = [
        this.rnd.pick(["email-password", "google", "github", "magic-link"] as const),
      ];
      if (this.rnd.chance(0.25)) providers.push("passkey");
      const banned = this.rnd.chance(0.08);
      const u: AuthUser = {
        id: this.rnd.id(),
        name: `${first} ${last}`,
        email: `${first}.${last}${i}@example.com`.toLowerCase(),
        emailVerified: providers[0] !== "email-password" || this.rnd.chance(0.75),
        image: null,
        createdAt,
        updatedAt: createdAt,
        lastSignInAt: null,
        providers,
        role: i === 0 || this.rnd.chance(0.06) ? "admin" : "user",
        banned,
        banReason: banned ? "Spam" : null,
        banExpires: banned && this.rnd.chance(0.5) ? t0 + this.rnd.int(1, 30) * DAY : null,
        twoFactorEnabled: this.rnd.chance(0.3),
        passkeys: providers.includes("passkey") ? this.rnd.int(1, 2) : 0,
      };
      this.users.push(u);
      this.event("sign-up", u.id, u.email, createdAt, { provider: providers[0]! });
      if (!banned) {
        for (let s = this.rnd.int(0, 3); s > 0; s--) {
          const at = t0 - this.rnd.int(0, 6 * 24 * 60) * 60_000;
          this.sessions.push({
            id: this.rnd.id(),
            userId: u.id,
            createdAt: at,
            expiresAt: at + this.config.sessions.expiresInSeconds * 1000,
            ipAddress: `203.0.113.${this.rnd.int(1, 254)}`,
            userAgent: this.rnd.pick(AGENTS),
            impersonatedBy: null,
          });
          u.lastSignInAt = Math.max(u.lastSignInAt ?? 0, at);
          this.event("sign-in", u.id, u.email, at, { provider: this.rnd.pick(providers) });
        }
      }
    }
    this.users.sort((a, b) => b.createdAt - a.createdAt);
    for (const name of ["Acme", "Globex", "Initech", "Umbrella"])
      this.orgs.push({
        id: this.rnd.id(),
        name,
        slug: name.toLowerCase(),
        createdAt: t0 - this.rnd.int(10, 200) * DAY,
        members: 0,
        invitations: 0,
      });
    // members from the users (the first an owner), and a few invitations in every status
    for (const org of this.orgs) {
      const people = this.users.filter((u) => !u.banned).slice();
      for (let n = this.rnd.int(2, 9); n > 0 && people.length > 0; n--) {
        const u = people.splice(this.rnd.int(0, people.length - 1), 1)[0]!;
        const role: AuthMemberRole = this.members.some((m) => m.organizationId === org.id)
          ? this.rnd.chance(0.25)
            ? "admin"
            : "member"
          : "owner";
        this.members.push({
          id: this.rnd.id(),
          organizationId: org.id,
          userId: u.id,
          name: u.name,
          email: u.email,
          role,
          createdAt: org.createdAt + this.rnd.int(0, 5) * DAY,
        });
      }
      for (let n = this.rnd.int(1, 4); n > 0; n--) {
        const createdAt = t0 - this.rnd.int(0, 10) * DAY;
        this.invitations.push({
          id: this.rnd.id(),
          organizationId: org.id,
          email: `${this.rnd.pick(FIRST)}.${this.rnd.pick(LAST)}@example.org`.toLowerCase(),
          role: this.rnd.chance(0.2) ? "admin" : "member",
          status: this.rnd.pick(["pending", "pending", "accepted", "canceled", "rejected"] as const),
          inviterId: this.members.find((m) => m.organizationId === org.id)?.userId ?? null,
          createdAt,
          expiresAt: createdAt + 2 * DAY,
        });
      }
    }
    this.events.sort((a, b) => b.time - a.time);
  }

  private event(action: string, userId: string | null, actor: string, time = this.now(), metadata: Json = {}) {
    this.events.unshift({ id: this.rnd.id(), time, action, userId, actor, ipAddress: null, metadata });
  }

  private user(id: string): AuthUser {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw new DataSourceError("not_found", `there is no user ${id}`);
    return u;
  }

  list(q: AuthUserQuery): Page<AuthUser> {
    const text = q.search?.trim().toLowerCase() ?? "";
    const rows = this.users.filter(
      (u) =>
        (text === "" || u.name.toLowerCase().includes(text) || u.email.toLowerCase().includes(text)) &&
        (q.provider === undefined || u.providers.includes(q.provider)) &&
        (q.status === undefined || userStatus(u) === q.status),
    );
    const start = q.cursor === null ? 0 : Number(q.cursor);
    const page = rows.slice(start, start + q.numItems);
    const end = start + page.length;
    return { page: structuredClone(page), isDone: end >= rows.length, continueCursor: String(end) };
  }

  get(id: string): AuthUser | null {
    const u = this.users.find((x) => x.id === id);
    return u ? structuredClone(u) : null;
  }

  create(input: { name: string; email: string; password?: string }): string {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new DataSourceError("invalid_request", "not an email address");
    if (this.users.some((u) => u.email === email))
      throw new DataSourceError("invalid_request", `a user with ${email} exists`);
    const t = this.now();
    const u: AuthUser = {
      id: this.rnd.id(),
      name: input.name.trim() || email,
      email,
      emailVerified: true,
      image: null,
      createdAt: t,
      updatedAt: t,
      lastSignInAt: null,
      providers: input.password ? ["email-password"] : [],
      role: "user",
      banned: false,
      banReason: null,
      banExpires: null,
      twoFactorEnabled: false,
      passkeys: 0,
    };
    this.users.unshift(u);
    this.event("create-user", u.id, "dashboard");
    return u.id;
  }

  invite(email: string) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()))
      throw new DataSourceError("invalid_request", "not an email address");
    this.event("invite", null, "dashboard", this.now(), { email: email.trim() });
  }

  sendEmail(userId: string, kind: AuthEmailAction) {
    const u = this.user(userId);
    this.event(`send-${kind}`, u.id, "dashboard", this.now(), { email: u.email });
  }

  listSessions(userId?: string): AuthSession[] {
    return structuredClone(
      this.sessions
        .filter((s) => userId === undefined || s.userId === userId)
        .sort((a, b) => b.createdAt - a.createdAt),
    );
  }

  revokeSession(id: string) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new DataSourceError("not_found", `there is no session ${id}`);
    this.sessions = this.sessions.filter((x) => x.id !== id);
    this.event("revoke-session", s.userId, "dashboard");
  }

  revokeUserSessions(userId: string): number {
    this.user(userId);
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.userId !== userId);
    this.event("revoke-sessions", userId, "dashboard");
    return before - this.sessions.length;
  }

  removeFactors(userId: string) {
    const u = this.user(userId);
    u.twoFactorEnabled = false;
    u.passkeys = 0;
    u.providers = u.providers.filter((p) => p !== "passkey");
    u.updatedAt = this.now();
    this.event("remove-factors", userId, "dashboard");
  }

  ban(userId: string, ban: { reason?: string; expiresInSeconds?: number }) {
    const u = this.user(userId);
    u.banned = true;
    u.banReason = ban.reason?.trim() || null;
    u.banExpires = ban.expiresInSeconds ? this.now() + ban.expiresInSeconds * 1000 : null;
    u.updatedAt = this.now();
    // a ban signs the user out, as the admin plugin's
    this.sessions = this.sessions.filter((s) => s.userId !== userId);
    this.event("ban", userId, "dashboard", this.now(), { reason: u.banReason, expires: u.banExpires });
  }

  unban(userId: string) {
    const u = this.user(userId);
    Object.assign(u, { banned: false, banReason: null, banExpires: null, updatedAt: this.now() });
    this.event("unban", userId, "dashboard");
  }

  impersonate(userId: string): string {
    const u = this.user(userId);
    if (u.banned) throw new DataSourceError("invalid_request", "a banned user cannot be impersonated");
    const t = this.now();
    const s: AuthSession = {
      id: this.rnd.id(),
      userId,
      createdAt: t,
      expiresAt: t + 3_600_000,
      ipAddress: null,
      userAgent: "bunvex dashboard",
      impersonatedBy: "dashboard",
    };
    this.sessions.push(s);
    this.event("impersonate", userId, "dashboard");
    return s.id;
  }

  remove(userId: string) {
    this.user(userId);
    this.users = this.users.filter((u) => u.id !== userId);
    this.sessions = this.sessions.filter((s) => s.userId !== userId);
    this.event("remove-user", userId, "dashboard");
  }

  organizations(): AuthOrganization[] {
    // the counts come from the members and the pending invitations, so they stay true after a change
    return this.orgs.map((o) => ({
      ...o,
      members: this.members.filter((m) => m.organizationId === o.id).length,
      invitations: this.invitations.filter((i) => i.organizationId === o.id && i.status === "pending").length,
    }));
  }

  private org(id: string): AuthOrganization {
    const o = this.orgs.find((x) => x.id === id);
    if (!o) throw new DataSourceError("not_found", `there is no organization ${id}`);
    return o;
  }

  private member(id: string): AuthMember {
    const m = this.members.find((x) => x.id === id);
    if (!m) throw new DataSourceError("not_found", `there is no member ${id}`);
    return m;
  }

  private invitation(id: string): AuthInvitation {
    const i = this.invitations.find((x) => x.id === id);
    if (!i) throw new DataSourceError("not_found", `there is no invitation ${id}`);
    return i;
  }

  /** An organization keeps at least one owner (as better-auth refuses to leave none). */
  private keepOwner(m: AuthMember, next: AuthMemberRole | null) {
    if (m.role !== "owner" || next === "owner") return;
    const owners = this.members.filter((x) => x.organizationId === m.organizationId && x.role === "owner");
    if (owners.length <= 1)
      throw new DataSourceError("invalid_request", "an organization needs an owner: make someone else owner first");
  }

  listMembers(organizationId: string): AuthMember[] {
    this.org(organizationId);
    return structuredClone(
      this.members.filter((m) => m.organizationId === organizationId).sort((a, b) => a.createdAt - b.createdAt),
    );
  }

  updateMemberRole(memberId: string, role: AuthMemberRole) {
    if (!/^[a-z][a-z0-9-]*$/.test(role)) throw new DataSourceError("invalid_request", `not a role: ${role}`);
    const m = this.member(memberId);
    this.keepOwner(m, role);
    m.role = role;
    this.event("update-member-role", m.userId, "dashboard", this.now(), { organization: m.organizationId, role });
  }

  removeMember(memberId: string) {
    const m = this.member(memberId);
    this.keepOwner(m, null);
    this.members = this.members.filter((x) => x.id !== memberId);
    this.event("remove-member", m.userId, "dashboard", this.now(), { organization: m.organizationId });
  }

  listInvitations(organizationId: string): AuthInvitation[] {
    this.org(organizationId);
    return structuredClone(
      this.invitations.filter((i) => i.organizationId === organizationId).sort((a, b) => b.createdAt - a.createdAt),
    );
  }

  inviteMember(organizationId: string, invite: { email: string; role: AuthMemberRole }): string {
    this.org(organizationId);
    const email = invite.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new DataSourceError("invalid_request", "not an email address");
    if (this.members.some((m) => m.organizationId === organizationId && m.email === email))
      throw new DataSourceError("invalid_request", `${email} is already a member`);
    if (
      this.invitations.some((i) => i.organizationId === organizationId && i.email === email && i.status === "pending")
    )
      throw new DataSourceError("invalid_request", `${email} already has a pending invitation`);
    const t = this.now();
    const id = this.rnd.id();
    this.invitations.push({
      id,
      organizationId,
      email,
      role: invite.role,
      status: "pending",
      inviterId: null,
      createdAt: t,
      expiresAt: t + 2 * DAY,
    });
    this.event("invite-member", null, "dashboard", t, { organization: organizationId, email, role: invite.role });
    return id;
  }

  resendInvitation(invitationId: string) {
    const i = this.invitation(invitationId);
    if (i.status !== "pending") throw new DataSourceError("invalid_request", `the invitation is ${i.status}`);
    i.expiresAt = this.now() + 2 * DAY;
    this.event("resend-invitation", null, "dashboard", this.now(), { email: i.email });
  }

  cancelInvitation(invitationId: string) {
    const i = this.invitation(invitationId);
    if (i.status !== "pending") throw new DataSourceError("invalid_request", `the invitation is ${i.status}`);
    i.status = "canceled";
    this.event("cancel-invitation", null, "dashboard", this.now(), { email: i.email });
  }

  getConfig(): AuthConfig {
    return structuredClone(this.config);
  }

  updateConfig(patch: Partial<AuthConfig>): AuthConfig {
    const keys = Object.keys(patch) as (keyof AuthConfig)[];
    for (const k of keys) if (!(k in this.config)) throw new DataSourceError("invalid_request", `no setting ${k}`);
    this.config = { ...this.config, ...structuredClone(patch) };
    this.event("update-config", null, "dashboard", this.now(), { pages: keys });
    return this.getConfig();
  }

  listEvents(q: { userId?: string; limit?: number }): AuthEvent[] {
    const rows = this.events.filter((e) => q.userId === undefined || e.userId === q.userId);
    return structuredClone(rows.slice(0, q.limit ?? 200));
  }
}

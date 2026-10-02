// The Authentication screen's contract (UI-01 §25, STUDY-12 §7.8): administering the app's own users, a bunvex
// addition — Convex has no such screen (Convex Auth and Clerk are administered elsewhere). Names and concepts
// follow better-auth (users, accounts per provider, sessions, verification, two-factor, passkeys,
// organizations / members / invitations, and its admin plugin: ban, impersonate, revoke sessions), without
// its code. Every method is optional: a source offers the screen by having `listAuthUsers` (detected with
// `typeof`); the rest light up the actions they back. Re-exported by `data-source.ts`.
import type { CallOptions, Json, Page, PageRequest } from "./data-source.ts";

/** A way to sign in (better-auth's account `providerId`). */
export type AuthProviderId =
  | "email-password"
  | "magic-link"
  | "google"
  | "github"
  | "apple"
  | "microsoft"
  | "passkey"
  | (string & {});

/** A user, as better-auth's `user` table with the admin and two-factor plugins' fields. */
export type AuthUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: number;
  updatedAt: number;
  /** The newest session's start, if any. */
  lastSignInAt: number | null;
  /** The providers with an account for this user (better-auth's `account.providerId`). */
  providers: AuthProviderId[];
  /** The admin plugin's role ("user", "admin", …). */
  role: string;
  banned: boolean;
  banReason: string | null;
  /** When a ban ends (ms); `null` while banned is for good. */
  banExpires: number | null;
  twoFactorEnabled: boolean;
  passkeys: number;
};

export type AuthUserStatus = "verified" | "unverified" | "banned";

export type AuthUserQuery = PageRequest & {
  /** Matches the name or the email, ignoring case. */
  search?: string;
  provider?: AuthProviderId;
  status?: AuthUserStatus;
};

/** A signed-in session (better-auth's `session`), with the admin plugin's `impersonatedBy`. */
export type AuthSession = {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  ipAddress: string | null;
  userAgent: string | null;
  impersonatedBy: string | null;
};

/** An organization (better-auth's organization plugin), with its member and pending invitation counts. */
export type AuthOrganization = {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  members: number;
  invitations: number;
};

/** A member's role in an organization (better-auth's organization plugin: owner, admin, member, or custom). */
export type AuthMemberRole = "owner" | "admin" | "member" | (string & {});
export const AUTH_MEMBER_ROLES: readonly AuthMemberRole[] = ["owner", "admin", "member"];

/** A user's membership of an organization (better-auth's `member`), with the user's name and email. */
export type AuthMember = {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  email: string;
  role: AuthMemberRole;
  createdAt: number;
};

/** An invitation to an organization (better-auth's `invitation`). */
export type AuthInvitation = {
  id: string;
  organizationId: string;
  email: string;
  role: AuthMemberRole;
  status: "pending" | "accepted" | "rejected" | "canceled";
  /** Who invited, a user id; `null` for the dashboard. */
  inviterId: string | null;
  createdAt: number;
  expiresAt: number;
};

/** What happened, for the auth audit log and a user's Logs tab. */
export type AuthEvent = {
  id: string;
  time: number;
  /** "sign-in", "sign-out", "sign-up", "password-reset", "ban", "impersonate", "revoke-sessions", … */
  action: string;
  userId: string | null;
  /** Who did it: the user, an admin, the dashboard. */
  actor: string;
  ipAddress: string | null;
  metadata: Json;
};

/** The emails the auth flows send. */
export type AuthEmailKind = "verify-email" | "password-reset" | "magic-link" | "invitation";

/** The authentication configuration, page by page (UI-01 §25.3). */
export type AuthConfig = {
  providers: { id: AuthProviderId; enabled: boolean; clientId?: string }[];
  multiFactor: { totp: boolean; otpEmail: boolean; backupCodes: boolean; required: "never" | "admins" | "everyone" };
  passkeys: { enabled: boolean; rpName: string; rpId: string };
  sessions: { expiresInSeconds: number; updateAgeSeconds: number; freshAgeSeconds: number };
  rateLimits: { enabled: boolean; windowSeconds: number; max: number };
  urls: { siteUrl: string; redirectAllowList: string[] };
  emails: Record<AuthEmailKind, { subject: string; body: string }>;
};

export type AuthEmailAction = "password-reset" | "magic-link" | "verify-email";

export interface AuthAdminFeatures {
  /** The app's users, newest first. Offering it offers the Authentication screen. */
  listAuthUsers?(query: AuthUserQuery, opts?: CallOptions): Promise<Page<AuthUser>>;
  getAuthUser?(id: string, opts?: CallOptions): Promise<AuthUser | null>;
  /** Creates a user with a verified email (and a password, when given); its id. */
  createAuthUser?(input: { name: string; email: string; password?: string }, opts?: CallOptions): Promise<string>;
  /** Sends an invitation to sign up. */
  inviteAuthUser?(email: string, opts?: CallOptions): Promise<void>;
  /** Sends one of the user's emails. */
  sendAuthEmail?(userId: string, kind: AuthEmailAction, opts?: CallOptions): Promise<void>;
  /** Sessions newest first; one user's, or everyone's. */
  listAuthSessions?(query: { userId?: string }, opts?: CallOptions): Promise<AuthSession[]>;
  revokeAuthSession?(sessionId: string, opts?: CallOptions): Promise<void>;
  /** Every session of a user; how many. */
  revokeAuthUserSessions?(userId: string, opts?: CallOptions): Promise<number>;
  /** Turns off two-factor and removes the user's factors and passkeys. */
  removeAuthUserFactors?(userId: string, opts?: CallOptions): Promise<void>;
  /** Bans (and signs out); for `expiresInSeconds`, or for good. */
  banAuthUser?(userId: string, ban: { reason?: string; expiresInSeconds?: number }, opts?: CallOptions): Promise<void>;
  unbanAuthUser?(userId: string, opts?: CallOptions): Promise<void>;
  /** A session acting as the user (the admin plugin's impersonation); its id. */
  impersonateAuthUser?(userId: string, opts?: CallOptions): Promise<string>;
  /** Deletes the user, their accounts and sessions. */
  removeAuthUser?(userId: string, opts?: CallOptions): Promise<void>;
  listAuthOrganizations?(opts?: CallOptions): Promise<AuthOrganization[]>;
  /** An organization's members, oldest first. Offering it offers the organization's panel. */
  listAuthMembers?(organizationId: string, opts?: CallOptions): Promise<AuthMember[]>;
  /** Changes a member's role. An organization keeps at least one owner. */
  updateAuthMemberRole?(memberId: string, role: AuthMemberRole, opts?: CallOptions): Promise<void>;
  /** Removes a member (not the user). An organization keeps at least one owner. */
  removeAuthMember?(memberId: string, opts?: CallOptions): Promise<void>;
  /** An organization's invitations, newest first, every status. */
  listAuthInvitations?(organizationId: string, opts?: CallOptions): Promise<AuthInvitation[]>;
  /** Invites an email to the organization with a role; the invitation's id. */
  inviteAuthMember?(
    organizationId: string,
    invite: { email: string; role: AuthMemberRole },
    opts?: CallOptions,
  ): Promise<string>;
  /** Sends a pending invitation's email again and extends its expiry. */
  resendAuthInvitation?(invitationId: string, opts?: CallOptions): Promise<void>;
  /** Cancels a pending invitation. */
  cancelAuthInvitation?(invitationId: string, opts?: CallOptions): Promise<void>;
  getAuthConfig?(opts?: CallOptions): Promise<AuthConfig>;
  /** Merges a page of the configuration (one top-level key at a time); the whole result. */
  updateAuthConfig?(patch: Partial<AuthConfig>, opts?: CallOptions): Promise<AuthConfig>;
  /** Newest first; one user's, or everyone's. */
  listAuthEvents?(query: { userId?: string; limit?: number }, opts?: CallOptions): Promise<AuthEvent[]>;
}

export const userStatus = (u: AuthUser): AuthUserStatus =>
  u.banned ? "banned" : u.emailVerified ? "verified" : "unverified";

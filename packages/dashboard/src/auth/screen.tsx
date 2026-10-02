// The Authentication screen (UI-01 §25, STUDY-12 §7.8), a bunvex addition: the app's users, sessions and
// organizations, and the auth configuration, page by page, in better-auth's terms — on the section column
// (§23): MANAGE (Users, Sessions, Organizations), CONFIGURATION (Sign in / Providers, Multi-factor, Passkeys,
// Session lifetime, Rate limits, URL configuration, Emails, Audit). Offered when the source has `listAuthUsers`.
import { useQueryScope } from "../context.tsx";
import { type AuthSection, authRoute, DashLink } from "../router.tsx";
import { BAR_TITLE, BAR1, SCREEN } from "../shell/bars.ts";
import { NotOffered } from "../shell/not-offered.tsx";
import { SECTION_ITEM, SectionColumn, SectionNav, useSectionSheet } from "../shell/section-column.tsx";
import { AuditPage, ConfigPage } from "./config.tsx";
import { OrganizationsPage, SessionsPage } from "./manage.tsx";
import { UserFilters, UsersPage } from "./users.tsx";

export const SECTION: Record<AuthSection, { title: string; description: string }> = {
  users: { title: "Users", description: "The people who sign in to your app" },
  sessions: { title: "Sessions", description: "Who is signed in, where" },
  organizations: { title: "Organizations", description: "Teams, their members and invitations" },
  providers: { title: "Sign in / Providers", description: "How users sign in, and the token providers" },
  "multi-factor": { title: "Multi-factor", description: "Second factors and who must use one" },
  passkeys: { title: "Passkeys", description: "WebAuthn sign-in" },
  // not "Sessions" again: that is the list of who is signed in (UX2-18)
  "session-lifetime": { title: "Session lifetime", description: "How long a session lasts and refreshes" },
  "rate-limits": { title: "Rate limits", description: "How many auth requests a client may make" },
  urls: { title: "URL configuration", description: "The site URL and where sign-in may redirect" },
  emails: { title: "Emails", description: "The templates the auth flows send" },
  audit: { title: "Audit", description: "What happened in auth, newest first" },
};

const MANAGE: AuthSection[] = ["users", "sessions", "organizations"];
const CONFIGURATION: AuthSection[] = [
  "providers",
  "multi-factor",
  "passkeys",
  "session-lifetime",
  "rate-limits",
  "urls",
  "emails",
  "audit",
];

function AuthNav() {
  const item = (section: AuthSection) => (
    <li key={section}>
      <DashLink link={{ to: "/auth/$section", params: { section } }} className={SECTION_ITEM}>
        {SECTION[section].title}
      </DashLink>
    </li>
  );
  return (
    <SectionNav
      label="Authentication"
      groups={[
        { label: "Manage", items: MANAGE.map(item) },
        { label: "Configuration", items: CONFIGURATION.map(item) },
      ]}
    />
  );
}

export function AuthScreen() {
  const { source } = useQueryScope();
  if (typeof source.listAuthUsers !== "function") return <NotOffered title="Authentication" what="user management" />;
  return <Auth />;
}

function Auth() {
  const { section } = authRoute.useParams();
  const known = (Object.keys(SECTION) as AuthSection[]).includes(section as AuthSection);
  const s = (known ? section : "users") as AuthSection;
  const sheet = useSectionSheet({
    kind: "auth-pages",
    label: "Pages",
    children: (
      <>
        <AuthNav />
        {s === "users" && <UserFilters />}
      </>
    ),
  });
  const heading = (
    <>
      <h1 className={BAR_TITLE}>{SECTION[s].title}</h1>
      <span className="hidden text-sm text-muted-foreground lg:inline">{SECTION[s].description}</span>
      {sheet.button}
    </>
  );
  return (
    <div className={SCREEN}>
      <SectionColumn title="Authentication" widthKey="bunvex-dashboard:auth-column-width">
        <AuthNav />
        {s === "users" && <UserFilters />}
      </SectionColumn>
      {s === "users" ? (
        <UsersPage heading={heading} />
      ) : s === "sessions" ? (
        <SessionsPage heading={heading} />
      ) : s === "organizations" ? (
        <OrganizationsPage heading={heading} />
      ) : s === "audit" ? (
        <AuditPage heading={heading} />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className={BAR1}>{heading}</div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
            <ConfigPage section={s} />
          </div>
        </div>
      )}
      {sheet.sheet}
    </div>
  );
}

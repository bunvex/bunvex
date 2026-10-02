// An auth email as the recipient would see it (UI-01 §25.3, Emails): the template's `{{variables}}` filled with
// sample values, inside a plain email layout, light or dark. Pure, so it is tested without a browser. The
// result is shown in a sandboxed iframe (no scripts, no same-origin), so HTML in a template cannot reach the
// dashboard; plain text is escaped and its line breaks and links kept.
import type { AuthEmailKind } from "../data-source.ts";

/** The variables each email fills in (as the auth flows send them). */
export const EMAIL_VARIABLES: Record<AuthEmailKind, readonly string[]> = {
  "verify-email": ["name", "email", "url"],
  "password-reset": ["name", "email", "url"],
  "magic-link": ["email", "url"],
  invitation: ["inviter", "organization", "role", "email", "url"],
};

/** What the preview fills them with. */
export const SAMPLE_VALUES: Record<string, string> = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  url: "https://acme.dev/auth/verify?token=5f2c…",
  inviter: "Grace Hopper",
  organization: "Acme",
  role: "member",
};

const VARIABLE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** The variables a text uses that its email does not fill in (they would reach the recipient as-is). */
export function unknownVariables(kind: AuthEmailKind, text: string): string[] {
  const known = new Set(EMAIL_VARIABLES[kind]);
  const out = new Set<string>();
  for (const m of text.matchAll(VARIABLE)) if (!known.has(m[1]!)) out.add(m[1]!);
  return [...out];
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Fills the variables it knows; unknown ones stay visible, marked, so the preview shows the mistake. */
export function fill(kind: AuthEmailKind, text: string, html: boolean): string {
  const known = new Set(EMAIL_VARIABLES[kind]);
  return text.replace(VARIABLE, (whole, name: string) => {
    if (!known.has(name)) return html ? `<mark>${escapeHtml(whole)}</mark>` : whole;
    const value = SAMPLE_VALUES[name] ?? name;
    return html ? escapeHtml(value) : value;
  });
}

/** A body that looks like HTML is used as such; anything else is text: escaped, links and line breaks kept. */
const looksLikeHtml = (s: string) => /<\/?[a-z][\s\S]*>/i.test(s);

function bodyHtml(kind: AuthEmailKind, body: string): string {
  // variables are filled as HTML (values escaped, unknown ones marked); `{{…}}` survives escaping unchanged
  if (looksLikeHtml(body)) return fill(kind, body, true);
  return fill(kind, escapeHtml(body), true)
    .replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** The whole preview document: subject line, then the body in a centred card. */
export function renderEmail(
  kind: AuthEmailKind,
  template: { subject: string; body: string },
  theme: "light" | "dark",
): string {
  const dark = theme === "dark";
  const bg = dark ? "#111316" : "#f4f5f7";
  const card = dark ? "#1b1e23" : "#ffffff";
  const fg = dark ? "#e8eaed" : "#16181d";
  const muted = dark ? "#9aa1ab" : "#5b616b";
  const link = dark ? "#8ab4ff" : "#1f5ad6";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:${bg};color:${fg};font:14px/1.6 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.meta{max-width:560px;margin:0 auto 12px;color:${muted};font-size:12px}
.meta b{color:${fg};font-weight:600}
.card{max-width:560px;margin:0 auto;background:${card};padding:24px 28px;border-radius:6px}
a{color:${link};word-break:break-all}
mark{background:#fde68a;color:#3f2d00;padding:0 2px}
p{margin:0 0 12px}
</style></head><body>
<div class="meta">To: ${escapeHtml(SAMPLE_VALUES.email!)}<br>Subject: <b>${fill(kind, template.subject, true)}</b></div>
<div class="card">${bodyHtml(kind, template.body)}</div>
</body></html>`;
}

// The query parameters the OAuth component appends to its callback redirect (STUDY-201 §1.11, C-5), shared by the
// component that writes them and the browser client that reads them. Prefixed rather than a bare `code` / `error`: the
// client's callback handler runs on every page load of every app, so bare names would take an unrelated flow's `?code=`,
// and the prefix is what tells a redirect came from this component. bunvex's words (DV-577).

/** The one-time code the client redeems for a session. */
export const OAUTH_CODE_PARAM = "bunvexAuthCode";

/** Why the flow failed: `access_denied`, `expired` or `oauth_error`. */
export const OAUTH_ERROR_PARAM = "bunvexAuthError";

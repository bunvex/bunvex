// The names the session's tokens are kept under (STUDY-201 §1.12, DV-577): the browser's storage keys, before their
// namespace, and the cookies' names under server rendering (STUDY-202 §1.2). Apart from `browser/storage.ts` so the
// server side can name them without the browser's code.

/** The storage key of the access token (a JWT), before its namespace. */
export const JWT_STORAGE_KEY = "__bunvexAuthJWT";
/** The storage key of the rotating refresh token, before its namespace (also the name of the refresh lock). */
export const REFRESH_TOKEN_STORAGE_KEY = "__bunvexAuthRefreshToken";

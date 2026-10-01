/**
 * An authentication failure, as Convex's `ErrorMetadata`: `kind` gives the HTTP status (Unauthenticated →
 * 401, BadRequest → 400), `code` the short name a client sees (`InvalidAuthHeader`, `NoAuthProvider`, …).
 */
export class AuthenticationError extends Error {
  override name = "AuthenticationError";
  constructor(
    readonly kind: "Unauthenticated" | "BadRequest",
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
  get status(): 401 | 400 {
    return this.kind === "Unauthenticated" ? 401 : 400;
  }
}

export const unauthenticated = (code: string, message: string) =>
  new AuthenticationError("Unauthenticated", code, message);
export const badRequest = (code: string, message: string) => new AuthenticationError("BadRequest", code, message);

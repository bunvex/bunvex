// `@bunvex/auth` (STUDY-201 §1.1), v2's `.`: the types the backend and the clients share. Types only, so any runtime can
// import it.
export type {
  AuthApi,
  IsAuthenticatedFn,
  RefreshResult,
  RefreshSessionFn,
  SignInComplete,
  SignInEnvelope,
  SignInError,
  SignOutFn,
  TokenBundle,
} from "./lib/types.ts";

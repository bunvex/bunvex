// `@bunvex/auth/browser` (STUDY-201 §1.1), v2's `./browser`: the client's building blocks without React (the token
// storage, the refresh lock, the session manager), which the React bindings build on, and other bindings can too.

export { runWithMutex } from "./mutex.ts";
export {
  AuthClient,
  type AuthClientConfig,
  type AuthState,
  type SpaAuthApi,
  type SsrAuthApi,
} from "./sessionManager.ts";
export {
  defaultStorage,
  InMemoryStorage,
  JWT_STORAGE_KEY,
  REFRESH_TOKEN_STORAGE_KEY,
  type TokenStorage,
} from "./storage.ts";

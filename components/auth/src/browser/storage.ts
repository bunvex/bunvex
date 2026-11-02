// Where the client keeps its tokens (STUDY-201 §1.12), v2's storage in bunvex's words (DV-577): any store of strings by
// key, sync or async (`localStorage`, `sessionStorage` for a session per tab, a secure store on React Native), each key
// suffixed with a namespace (the deployment's URL by default) so deployments sharing one origin's storage keep apart.
// Nothing here knows React or a backend client.

/**
 * A store of string values by key. Each method may return a promise, so an async store (a React Native secure store)
 * works as is; `localStorage` and `sessionStorage` are ones already.
 */
export interface TokenStorage {
  /** Read a value. */
  getItem: (key: string) => string | undefined | null | Promise<string | undefined | null>;
  /** Write a value. */
  setItem: (key: string, value: string) => void | Promise<void>;
  /** Remove a value. */
  removeItem: (key: string) => void | Promise<void>;
}

/** The storage key of the access token (a JWT), before its namespace. */
export const JWT_STORAGE_KEY = "__bunvexAuthJWT";
/** The storage key of the rotating refresh token, before its namespace (also the name of the refresh lock). */
export const REFRESH_TOKEN_STORAGE_KEY = "__bunvexAuthRefreshToken";
/** The prefix of an ambient sign-in's own keys. */
const SIGN_IN_KEY_PREFIX = "__bunvexAuthProvider_";

/** A {@link TokenStorage} in memory: where nothing persists (a server, a runtime without storage). Lost on reload. */
export class InMemoryStorage implements TokenStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

let warned = false;

/** Lets a test see the in-memory warning again (it is once per process). */
export function resetInMemoryFallbackWarning(): void {
  warned = false;
}

/**
 * The storage used when none is given: the browser's `localStorage`, else (a runtime with a `window` but no
 * `localStorage`, React Native) one in memory, with a warning once. Pass your own for per-tab sessions or React Native.
 */
export function defaultStorage(): TokenStorage {
  if (typeof window !== "undefined") {
    if (window.localStorage) return window.localStorage;
    if (!warned) {
      warned = true;
      console.warn(
        "[bunvex-auth] This runtime has no `localStorage`, so the session is being kept in memory and will not " +
          "survive an app restart. Pass a `storage` implementation to your auth provider to persist it. For React " +
          "Native, that would be one backed by something like `expo-secure-store`.",
      );
    }
  }
  return new InMemoryStorage();
}

/**
 * One ambient sign-in's view of the storage, its keys prefixed with its id. Keys go to the store as given: keep them to
 * `[A-Za-z0-9._-]` for stores like Expo SecureStore.
 */
export type SignInStorage = {
  /** Read a value. */
  get(key: string): ReturnType<TokenStorage["getItem"]>;
  /** Write a value. */
  set(key: string, value: string): ReturnType<TokenStorage["setItem"]>;
  /** Remove a value. */
  remove(key: string): ReturnType<TokenStorage["removeItem"]>;
};

/**
 * A {@link TokenStorage} whose keys end in `_<namespace>`, the namespace stripped to `[A-Za-z0-9]` (for React Native's
 * stores): two clients with one namespace share a session, different ones keep apart. Two namespaces with the same
 * letters and digits share keys.
 */
export class NamespacedStorage {
  /** The storage underneath, to tell a `storage` event's area apart. */
  readonly storage: TokenStorage;
  private readonly suffix: string;

  constructor(storage: TokenStorage, namespace: string) {
    this.storage = storage;
    this.suffix = namespace.replace(/[^a-zA-Z0-9]/g, "");
  }

  /** The key `key` is stored under. */
  key(key: string): string {
    return `${key}_${this.suffix}`;
  }

  get(key: string) {
    return this.storage.getItem(this.key(key));
  }
  set(key: string, value: string) {
    return this.storage.setItem(this.key(key), value);
  }
  remove(key: string) {
    return this.storage.removeItem(this.key(key));
  }

  /**
   * The storage of the ambient sign-in `id`: `key` stored as `__bunvexAuthProvider_<id>_<key>`, then namespaced, so it
   * meets neither the token keys nor another sign-in's.
   */
  forSignIn(id: string): SignInStorage {
    const prefix = `${SIGN_IN_KEY_PREFIX}${id}_`;
    return {
      get: (key) => this.get(prefix + key),
      set: (key, value) => this.set(prefix + key, value),
      remove: (key) => this.remove(prefix + key),
    };
  }
}

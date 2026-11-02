// Values ambient sign-ins publish for their hooks (STUDY-201 §1.12), as v2's: an action registered at setup, a status
// such as an OAuth error, by key, with subscriptions. A value is replaced, never mutated, so a read is a snapshot
// `useSyncExternalStore` can compare. One store per client.

/** A sign-in's own view of the store, its keys under its scope: what its setup writes through. */
export type SignInValues = {
  /** Read the value at `key` in the scope. */
  get<T>(key: string): T | undefined;
  /** Replace the value at `key` in the scope. */
  set<T>(key: string, value: T): void;
};

/** A read-only view of a sign-in's values, its keys under its scope: what hooks read and subscribe through. */
export type SignInValuesReader = {
  /** Read the value at `key` in the scope. */
  get<T>(key: string): T | undefined;
  /** Be told when the value at `key` in the scope changes; returns the unsubscribe. */
  subscribe(key: string, listener: () => void): () => void;
};

const scoped = (scope: string, key: string) => `${scope}/${key}`;

/** A store of values by key, each key with its subscribers. */
export class KeyedStore {
  readonly #values = new Map<string, unknown>();
  readonly #listeners = new Map<string, Set<() => void>>();

  /** The value at `key`, or `undefined`. */
  get<T>(key: string): T | undefined {
    return this.#values.get(key) as T | undefined;
  }

  /** Replace the value at `key`, and tell its subscribers. */
  set<T>(key: string, value: T): void {
    this.#values.set(key, value);
    for (const listener of this.#listeners.get(key) ?? []) listener();
  }

  /** Be told when the value at `key` changes (then read it with `get`); returns the unsubscribe. */
  subscribe(key: string, listener: () => void): () => void {
    let listeners = this.#listeners.get(key);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** The store seen by the sign-in `scope`: `key` is `<scope>/<key>`. */
  forSignIn(scope: string): SignInValues {
    return {
      get: <T>(key: string) => this.get<T>(scoped(scope, key)),
      set: <T>(key: string, value: T) => this.set(scoped(scope, key), value),
    };
  }

  /** The read-only view of the sign-in `scope`'s values. */
  forSignInReader(scope: string): SignInValuesReader {
    return {
      get: <T>(key: string) => this.get<T>(scoped(scope, key)),
      subscribe: (key, listener) => this.subscribe(scoped(scope, key), listener),
    };
  }
}

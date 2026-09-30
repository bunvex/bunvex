// What the client ASKS FOR, as Convex's `sync/local_state.ts`: the subscribed queries (one query id per
// distinct path + args, shared by its subscribers), the query-set version the next `ModifyQuerySet` builds on,
// and the auth token with its identity version. Query RESULTS live elsewhere (remote-query-set.ts,
// optimistic-updates.ts).
import type { v1 } from "@bunvex/protocol";
import { toJsonValue, type Value } from "@bunvex/values";
import { canonicalizeUdfPath, type QueryToken, serializePathAndArgs } from "./udf-path.ts";

type LocalQuery = {
  id: v1.QueryId;
  canonicalizedUdfPath: string;
  args: Record<string, Value>;
  numSubscribers: number;
  journal?: v1.QueryJournal;
  componentPath?: string;
};

export type AuthState =
  | { tokenType: "User"; value: string }
  | { tokenType: "Admin"; value: string; impersonating?: v1.JSONValue };

export class LocalSyncState {
  private nextQueryId = 0;
  private querySetVersion = 0;
  private identityVersion = 0;
  private readonly querySet = new Map<QueryToken, LocalQuery>();
  private readonly queryIdToToken = new Map<v1.QueryId, QueryToken>();
  private auth: AuthState | undefined;
  private readonly outstandingQueriesOlderThanRestart = new Set<v1.QueryId>();
  private outstandingAuthOlderThanRestart = false;
  private paused = false;
  private readonly pendingQuerySetModifications = new Map<v1.QueryId, v1.AddQuery | v1.RemoveQuery>();

  /** Whether everything re-sent on the last reconnect has been answered (backoff resets only then). */
  hasSyncedPastLastReconnect(): boolean {
    return this.outstandingQueriesOlderThanRestart.size === 0 && !this.outstandingAuthOlderThanRestart;
  }

  markAuthCompletion() {
    this.outstandingAuthOlderThanRestart = false;
  }

  subscribe(
    udfPath: string,
    args: Record<string, Value>,
    journal?: v1.QueryJournal,
    componentPath?: string,
  ): {
    queryToken: QueryToken;
    modification: v1.ModifyQuerySet | null;
    unsubscribe: () => v1.ModifyQuerySet | null;
  } {
    const canonicalizedUdfPath = canonicalizeUdfPath(udfPath);
    const queryToken = serializePathAndArgs(canonicalizedUdfPath, args);
    const unsubscribe = () => this.removeSubscriber(queryToken);
    const existing = this.querySet.get(queryToken);
    if (existing !== undefined) {
      existing.numSubscribers += 1;
      return { queryToken, modification: null, unsubscribe };
    }
    const queryId = this.nextQueryId++;
    this.querySet.set(queryToken, {
      id: queryId,
      canonicalizedUdfPath,
      args,
      numSubscribers: 1,
      journal,
      componentPath,
    });
    this.queryIdToToken.set(queryId, queryToken);
    const baseVersion = this.querySetVersion;
    const newVersion = baseVersion + 1;
    const add: v1.AddQuery = {
      type: "Add",
      queryId,
      udfPath: canonicalizedUdfPath,
      args: [toJsonValue(args) as v1.JSONValue],
      ...(journal === undefined ? {} : { journal }),
      ...(componentPath === undefined ? {} : { componentPath }),
    };
    if (this.paused) this.pendingQuerySetModifications.set(queryId, add);
    else this.querySetVersion = newVersion;
    return {
      queryToken,
      modification: { type: "ModifyQuerySet", baseVersion, newVersion, modifications: [add] },
      unsubscribe,
    };
  }

  transition(transition: v1.Transition) {
    for (const m of transition.modifications) {
      this.outstandingQueriesOlderThanRestart.delete(m.queryId);
      if (m.type === "QueryRemoved") continue;
      // The journal of a query we have since unsubscribed from is ignored.
      if (m.journal !== undefined) {
        const token = this.queryIdToToken.get(m.queryId);
        if (token !== undefined) this.querySet.get(token)!.journal = m.journal;
      }
    }
  }

  queryId(udfPath: string, args: Record<string, Value>): v1.QueryId | null {
    return this.querySet.get(serializePathAndArgs(canonicalizeUdfPath(udfPath), args))?.id ?? null;
  }

  isCurrentOrNewerAuthVersion(version: v1.IdentityVersion): boolean {
    return version >= this.identityVersion;
  }

  getAuth(): AuthState | undefined {
    return this.auth;
  }

  setAuth(value: string): v1.Authenticate {
    this.auth = { tokenType: "User", value };
    return { type: "Authenticate", baseVersion: this.bumpIdentity(), tokenType: "User", value };
  }

  setAdminAuth(value: string, impersonating?: v1.JSONValue): v1.Authenticate {
    this.auth = { tokenType: "Admin", value, ...(impersonating === undefined ? {} : { impersonating }) };
    return { type: "Authenticate", baseVersion: this.bumpIdentity(), ...this.auth };
  }

  clearAuth(): v1.Authenticate {
    this.auth = undefined;
    this.markAuthCompletion();
    return { type: "Authenticate", tokenType: "None", baseVersion: this.bumpIdentity() };
  }

  /** The base version of the next Authenticate; the version advances unless paused (resume() sends it). */
  private bumpIdentity() {
    const base = this.identityVersion;
    if (!this.paused) this.identityVersion = base + 1;
    return base;
  }

  hasAuth(): boolean {
    return !!this.auth;
  }

  isNewAuth(value: string): boolean {
    return this.auth?.value !== value;
  }

  queryPath(queryId: v1.QueryId): string | null {
    const token = this.queryIdToToken.get(queryId);
    return token ? this.querySet.get(token)!.canonicalizedUdfPath : null;
  }

  queryArgs(queryId: v1.QueryId): Record<string, Value> | null {
    const token = this.queryIdToToken.get(queryId);
    return token ? this.querySet.get(token)!.args : null;
  }

  queryToken(queryId: v1.QueryId): QueryToken | null {
    return this.queryIdToToken.get(queryId) ?? null;
  }

  queryJournal(queryToken: QueryToken): v1.QueryJournal | undefined {
    return this.querySet.get(queryToken)?.journal;
  }

  /**
   * A new socket: the whole query set as `ModifyQuerySet` 0 → 1 (with each query's journal), then the auth
   * token again when there is one. Works whether paused or not.
   */
  restart(): [v1.ModifyQuerySet, v1.Authenticate?] {
    this.unpause();
    this.outstandingQueriesOlderThanRestart.clear();
    const modifications: v1.AddQuery[] = [];
    for (const q of this.querySet.values()) {
      modifications.push({
        type: "Add",
        queryId: q.id,
        udfPath: q.canonicalizedUdfPath,
        args: [toJsonValue(q.args) as v1.JSONValue],
        ...(q.journal === undefined ? {} : { journal: q.journal }),
        ...(q.componentPath === undefined ? {} : { componentPath: q.componentPath }),
      });
      // Every re-sent query stays outstanding until the server answers it, so backoff does not reset early.
      this.outstandingQueriesOlderThanRestart.add(q.id);
    }
    this.querySetVersion = 1;
    const querySet: v1.ModifyQuerySet = { type: "ModifyQuerySet", baseVersion: 0, newVersion: 1, modifications };
    if (!this.auth) {
      this.identityVersion = 0;
      return [querySet];
    }
    this.outstandingAuthOlderThanRestart = true;
    this.identityVersion = 1;
    return [querySet, { type: "Authenticate", baseVersion: 0, ...this.auth }];
  }

  pause() {
    this.paused = true;
  }

  resume(): [v1.ModifyQuerySet | undefined, v1.Authenticate | undefined] {
    const querySet: v1.ModifyQuerySet | undefined =
      this.pendingQuerySetModifications.size > 0
        ? {
            type: "ModifyQuerySet",
            baseVersion: this.querySetVersion,
            newVersion: ++this.querySetVersion,
            modifications: [...this.pendingQuerySetModifications.values()],
          }
        : undefined;
    const authenticate: v1.Authenticate | undefined =
      this.auth !== undefined ? { type: "Authenticate", baseVersion: this.identityVersion++, ...this.auth } : undefined;
    this.unpause();
    return [querySet, authenticate];
  }

  private unpause() {
    this.paused = false;
    this.pendingQuerySetModifications.clear();
  }

  private removeSubscriber(queryToken: QueryToken): v1.ModifyQuerySet | null {
    const q = this.querySet.get(queryToken)!;
    if (q.numSubscribers > 1) {
      q.numSubscribers -= 1;
      return null;
    }
    this.querySet.delete(queryToken);
    this.queryIdToToken.delete(q.id);
    this.outstandingQueriesOlderThanRestart.delete(q.id);
    const baseVersion = this.querySetVersion;
    const newVersion = baseVersion + 1;
    const remove: v1.RemoveQuery = { type: "Remove", queryId: q.id };
    if (this.paused) {
      // An Add not yet sent cancels out; otherwise the Remove waits for resume().
      if (this.pendingQuerySetModifications.has(q.id)) this.pendingQuerySetModifications.delete(q.id);
      else this.pendingQuerySetModifications.set(q.id, remove);
    } else {
      this.querySetVersion = newVersion;
    }
    return { type: "ModifyQuerySet", baseVersion, newVersion, modifications: [remove] };
  }
}

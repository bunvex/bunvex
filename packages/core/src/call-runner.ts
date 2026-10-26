// The body runner (STUDY-194 §4.1; STUDY-190 PR 2a): the side of the call boundary a worker will host. It takes a
// request as text, begins the call's transaction through its host, runs the body and answers the outcome as text.
// The main thread's side, the dispatcher, keeps the engine around it: the permits, the query cache, the commit and
// its retries, the subscriptions (`Engine.execute`).
//
// In PR 2a both sides are in the main thread and every query and mutation a client calls goes through the codec
// (`call-wire.ts`) and back. What the outcome does not carry yet stays in the thread beside it (`CallLocal`): the
// value an in-process caller gets, the error object, and what a mutation's commit still takes from its transaction
// (after-commit callbacks, the search indexes' derived data, created tables, commit timestamps). PR 2b and PR 3 move
// those into the outcome as each kind of call leaves the thread.
import { toJsonValue, type Value } from "@bunvex/values";
import {
  type CallKind,
  type CallOutcome,
  type CallRequest,
  type CallSpec,
  type CallStatus,
  decodeCallRequest,
  encodeCallOutcome,
} from "./call-wire.ts";
import { type ExecutionKind, type Observed, onWork, runDeterministic, settled } from "./determinism.ts";
import type { RequestMetadata, TxBody } from "./engine.ts";
import {
  findSessionRequest,
  recordSessionRequest,
  type SessionRequestId,
  type SessionRequestOutcome,
} from "./session-requests.ts";
import type { Tx } from "./tx.ts";

/** How a transaction begins: everything a host needs to build it. */
export type TxStart = {
  kind: ExecutionKind;
  ts: bigint;
  now: number;
  /** The engine's own transaction (system tables writable). */
  system: boolean;
  identity: unknown;
  systemIdentity: boolean;
  request: RequestMetadata | null;
  /** A subscription's run: reactive pagination's journal, and no index cache (as `queryTracked` always ran). */
  tracked: boolean;
  journal: string | null;
};

/**
 * What a call's transaction reaches on the runner's side (STUDY-194 §4.11): in the main thread, the engine's own
 * store, catalog and services; in a worker, its own connection and epochs, with `count` and `search` asked of the
 * main thread.
 */
export interface CallHost {
  /** A transaction at `start.ts`, wired to this side's store and services. */
  begin(start: TxStart): Tx;
  /** Keeps table counts at `ts` while the call runs (STUDY-107); the function returned lets them go. */
  pin(ts: bigint): () => void;
  /** What a mutation's transaction writes in itself once its body returned: a staged or pending schema's failure. */
  finish(tx: Tx): Promise<void>;
}

/** The code a call runs, on the runner's side: in-thread, the server's functions that dispatched it. */
export interface CallBodies {
  /** The body for `request`; `local` is what an in-thread call hands over beside it (a sync mutation's deadline). */
  body(request: CallRequest, local: unknown): TxBody<unknown>;
  /** A session mutation's outcome as recorded with its writes, from the value it returned. */
  record(value: unknown): SessionRequestOutcome;
}

/** A call the engine runs through the boundary, instead of a transaction body. */
export type Call = {
  readonly spec: CallSpec;
  readonly bodies: CallBodies;
  /**
   * A query's permit (STUDY-68), taken once its snapshot is chosen, after the dispatcher checked its path and
   * arguments (Convex's `CacheManager::get`); resolves to its release. A mutation's is the engine's to take per
   * attempt (`MutationOptions.permit`).
   */
  readonly permit?: () => Promise<() => void>;
  /** Beside the request, in-thread only: a sync mutation's deadline. A worker will get `cancel` (STUDY-194 §4.12). */
  readonly local?: unknown;
};

export const isCall = (b: unknown): b is Call => typeof b === "object" && b !== null && "spec" in b;

/** A transaction's run: its value or error, and the transaction. */
export type Settled<T> = { tx: Tx; observedTime: boolean } & ({ ok: true; value: T } | { ok: false; error: unknown });

/** What stays in the thread beside an outcome, in PR 2a (see the header). */
export type CallLocal = { tx: Tx; value: unknown; error: unknown };

/** Run `body` in a new transaction from `host`, as a deterministic execution frozen at `start.now`. */
export async function runTransaction<T>(host: CallHost, start: TxStart, body: TxBody<T>): Promise<Settled<T>> {
  const tx = host.begin(start);
  const observed: Observed = { time: false };
  // Its count changes are kept while it runs (STUDY-107): a `count()` holds at its snapshot, however old.
  const unpin = host.pin(start.ts);
  try {
    const value = settled(
      observed,
      await runDeterministic(
        start.kind,
        start.now,
        async () => {
          // What the function waits on outside the store is counted in flight (STUDY-188 §X16).
          onWork((p) => tx.track(p));
          const v = await body(tx);
          // An unawaited write is part of the mutation (Convex runs every syscall to its end): wait for them.
          if (start.kind === "mutation") await tx.settle();
          return v;
        },
        observed,
      ),
    );
    if (start.kind === "mutation") await host.finish(tx);
    return { ok: true, value, tx, observedTime: observed.time };
  } catch (error) {
    return { ok: false, error, tx, observedTime: observed.time };
  } finally {
    tx.indexSpans?.finish();
    unpin();
  }
}

/** A run's outcome: its reads, and a mutation's writes if it returned. */
export function outcomeOf(
  id: number,
  kind: ExecutionKind,
  run: Settled<unknown>,
  status: CallStatus,
  result: string | null,
): CallOutcome {
  const tx = run.tx;
  return {
    id,
    status,
    result,
    reads: tx.reads,
    searchReads: tx.searchReads,
    identityObserved: tx.identityObserved,
    observedTime: run.observedTime,
    endCursor: tx.nextEndCursor,
    documentsRead: tx.usage.documentsRead,
    bytesRead: tx.usage.bytesRead,
    writes:
      kind === "mutation" && status === "ok" && tx.hasWrites
        ? { ...tx.toWrites(), touches: tx.catalogTouches() }
        : null,
  };
}

/** A session mutation's attempt refused its permit, and nothing was recorded to answer instead. */
export const REFUSED = Symbol("refused");

/**
 * A sync session's mutation (STUDY-23 §4.3), run at most once per request: a request already committed answers its
 * recorded outcome; otherwise a refused permit refuses it (Convex's d328f85: "committed mutations can be replayed
 * even if permit acquisition failed"); otherwise it runs, and its outcome is recorded with its writes.
 */
export async function inSession<T>(
  db: Tx,
  session: SessionRequestId,
  refused: boolean,
  run: () => Promise<T>,
  record: (value: T) => SessionRequestOutcome,
): Promise<{ value: T } | { replayed: SessionRequestOutcome } | typeof REFUSED> {
  const prior = await findSessionRequest(db, session);
  if (prior) return { replayed: prior };
  if (refused) return REFUSED;
  const value = await run();
  await recordSessionRequest(db, session, record(value));
  return { value };
}

/** A query's value as the text the cache and the transports send, or null when it is no value the text holds. */
function resultText(value: unknown): string | null {
  try {
    return JSON.stringify(toJsonValue((value ?? null) as Value));
  } catch {
    return null;
  }
}

/** Runs requests on `host`. */
export class CallRunner {
  constructor(private readonly host: CallHost) {}

  async run(wire: string, bodies: CallBodies, local: unknown): Promise<{ wire: string; local: CallLocal }> {
    const request = decodeCallRequest(wire);
    const kind: CallKind = request.kind;
    const body = bodies.body(request, local);
    const session = request.session;
    const run = await runTransaction(
      this.host,
      {
        kind,
        ts: request.ts,
        now: request.now,
        system: false,
        identity: request.identity === null ? null : JSON.parse(request.identity),
        systemIdentity: request.systemIdentity,
        request: request.request,
        tracked: request.tracked,
        journal: request.journal,
      },
      session
        ? (db) =>
            inSession(
              db,
              session,
              request.refused,
              async () => body(db),
              (v) => bodies.record(v),
            )
        : body,
    );
    let status: CallStatus = run.ok ? "ok" : "failed";
    let result: string | null = null;
    if (run.ok && run.value === REFUSED) status = "refused";
    else if (run.ok && session && "replayed" in (run.value as object)) {
      status = "replayed";
      result = JSON.stringify((run.value as { replayed: SessionRequestOutcome }).replayed);
    } else if (run.ok && kind === "query") result = resultText(run.value);
    return {
      wire: encodeCallOutcome(outcomeOf(request.id, kind, run, status, result)),
      local: { tx: run.tx, value: run.ok ? run.value : undefined, error: run.ok ? undefined : run.error },
    };
  }
}

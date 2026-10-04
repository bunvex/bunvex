// What every HTTP log stream sink shares (STUDY-59, STUDY-70), as Convex's crates/log_streaming/src/sinks:
// the sink interface, Convex's failure classification (`SinkEgressFailure`: another 4xx is rejected and not
// retried; 5xx, 408, 421, 425 and 429 are transient), full-jitter backoff, the general topic filter, and a
// POST with retries whose backoff state belongs to the sink (reset only after a batch succeeds).
import type { LogEvent, LogTopic } from "./log-events.ts";

export interface Sink {
  /** Convex's per-sink channel, in drains: further drains are dropped while it is full. */
  readonly capacity: number;
  verify(): Promise<void>;
  send(events: LogEvent[]): Promise<void>;
  stop(): void;
}

/** A failed delivery, as Convex's `SinkEgressFailure`: `rejected` (another 4xx) is not retried. */
export class EgressFailure extends Error {
  constructor(
    message: string,
    readonly rejected: boolean,
  ) {
    super(message);
  }
}

/** HTTP's canonical reason phrases, as reqwest's `StatusCode` Display uses them. */
const REASONS: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  507: "Insufficient Storage",
  508: "Loop Detected",
  511: "Network Authentication Required",
};

/** A status as Convex's failure messages print it: `404 Not Found`. */
export const statusText = (r: { status: number; statusText: string }) => {
  const reason = REASONS[r.status] ?? r.statusText;
  return `${r.status}${reason ? ` ${reason}` : ""}`;
};

export type BackoffOptions = { random: () => number };

export async function backoff(
  o: BackoffOptions,
  [initial, max]: [number, number],
  failures: number,
  stopped: () => boolean,
) {
  const ms = Math.min(initial * 2 ** failures, max) * o.random();
  const end = Date.now() + ms;
  while (Date.now() < end && !stopped()) await Bun.sleep(Math.min(50, end - Date.now()));
}

/** A general sink's filter (Convex's `SinkFilter`): verification always; exceptions never; `custom_audit` only when subscribed. */
export function passes(topics: LogTopic[] | undefined, e: LogEvent): boolean {
  const t = e.event.topic;
  if (t === "verification") return true;
  if (t === "exception") return false;
  return topics === undefined ? true : topics.includes(t);
}

/** The exception sinks' filter (Convex's `OnlyExceptions`). */
export const onlyExceptions = (e: LogEvent) => e.event.topic === "exception";

/** The User-Agent of every sink request (Convex sends `Convex/1.0`; STUDY-70: bunvex's own). */
export const SINK_USER_AGENT = "Bunvex/1.0";

/**
 * Convex's provider send loop: up to `attempts`, each failure followed by a backoff (the last one too);
 * a rejection ends it at once. The failure count lives in `state` across batches and resets on success.
 */
export async function postWithRetry(
  o: BackoffOptions & { fetch: typeof fetch },
  state: { failures: number; stopped: boolean; backoffMs: [number, number] },
  url: string,
  init: { headers: Record<string, string>; body: string },
  attempts: number,
): Promise<void> {
  let last = "";
  for (let n = 0; n < attempts; n++) {
    if (state.stopped) throw new EgressFailure("the log stream stopped", false);
    try {
      const r = await o.fetch(url, {
        method: "POST",
        headers: { "user-agent": SINK_USER_AGENT, ...init.headers },
        body: init.body,
      });
      await r.arrayBuffer().catch(() => undefined);
      if (r.status < 400) {
        state.failures = 0;
        return;
      }
      const transient = r.status >= 500 || [408, 421, 425, 429].includes(r.status);
      if (!transient) throw new EgressFailure(`endpoint rejected the request with ${statusText(r)}`, true);
      last = `endpoint returned ${statusText(r)}`;
    } catch (e) {
      if (e instanceof EgressFailure) throw e;
      last = (e as Error).message;
    }
    await backoff(o, state.backoffMs, state.failures++, () => state.stopped);
  }
  throw new EgressFailure(`gave up after ${attempts} attempts, last failure: ${last}`, false);
}

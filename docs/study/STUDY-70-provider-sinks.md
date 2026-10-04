# STUDY-70 — Provider log stream sinks: Datadog, Axiom, Sentry, PostHog Logs, PostHog Error Tracking

- **Status:** implemented. Owner decision (2026-10-03): every name Convex puts in these payloads is bunvex's
  (as DV-304 did for the webhook), recorded in DV-304.
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-03
- **Related:** [STUDY-59](STUDY-59-log-streams.md) (the log stream manager, the webhook and the API; DV-303
  to DV-305)

## 1. How Convex does it

Sources: `crates/log_streaming/src/sinks/{datadog,axiom,sentry,posthog_logs,posthog_error_tracking,failure,utils}.rs`,
`crates/log_streaming/src/lib.rs` (the event JSON), `crates/common/src/log_streaming.rs`.

### 1.1 What every provider sink shares

- **The manager** (STUDY-59) hands each sink drains of events; a sink's queue drops drains while full.
- **Verification.** When a stream is created or updated, the sink sends one verification event (Sentry
  sends nothing). A failure marks the stream failed with the failure's text.
- **Failures** (`failure.rs`):
  - another 4xx is a rejection: `endpoint rejected the request with 403 Forbidden`, not retried;
  - a 5xx, 408, 421, 425 or 429, or a network error, is transient: retried with full-jitter backoff
    (per sink: 500 ms initial, 60 s max), and after the last attempt
    `gave up after N attempts, last failure: endpoint returned 503 Service Unavailable`;
  - the failure counter belongs to the sink and resets after a batch succeeds.
- **The User-Agent** is `Convex/1.0`.
- **The event JSON** is the V2 format of the webhook, with the deployment metadata under `convex`.

### 1.2 Datadog

- `POST https://http-intake.logs.<site>/api/v2/logs` (the site from `siteLocation`: US1, US3, US5, EU,
  US1_FED, AP1), header `DD-API-KEY`, JSON.
- Each event is wrapped: `ddsource: "convex"`, `ddtags` (the tags joined by commas), `hostname` (the
  deployment), `service` (null), and the event's fields.
- Batches of at most 1000 events and 4 MiB (`build_sized_batches`, brackets and commas counted); 6 attempts.
- Exceptions are not sent.

### 1.3 Axiom

- `POST https://api.axiom.co/v1/datasets/<dataset>/ingest`, or, with an edge `ingestUrl`,
  `<ingestUrl>/v1/ingest/<dataset>`; `Authorization: Bearer <apiKey>`.
- Each event is `{_time, data: <event>, attributes: {…}, convex: {…}}`; the attributes are a map, so a
  repeated key keeps the last value, sorted by key.
- Batches of 10 000; exceptions are not sent.

### 1.4 Sentry

- The DSN is parsed as the Sentry SDK does: `<scheme>://<public>[:<secret>]@<host>[:port]/[<path>/]<project>`.
- Only exceptions are sent, one envelope each, to `<scheme>://<host>/[<path>/]api/<project>/envelope/`:
  - three lines: `{event_id}`, `{type: "event", length}`, the event;
  - `X-Sentry-Auth: Sentry sentry_key=…, sentry_version=7, sentry_timestamp=…, sentry_client=…[, sentry_secret=…]`.
- The event: `event_id` (32 hex), `platform: "node"`, `server_name` (the deployment), the exception
  (`type`, `value`, the stack frames oldest first, `in_app` unless under `node_modules`), tags (the stream's
  tags, then `func`, `func_type`, `func_runtime`, `request_id`), the user (token identifier, IP), a
  `ConvexError` context with the error's data, the SDK name and version.
- The SDK's transport: the status is ignored except for rate limits (`X-Sentry-Rate-Limits`, else
  `Retry-After`, else 60 s after a 429); a queue of 30 envelopes; verification is a no-op.

### 1.5 PostHog Logs

- `POST <host>/i/v1/logs`, `Authorization: Bearer <apiKey>`, an OTLP JSON `resourceLogs` document:
  resource attributes `service.name` and `convex.deployment.name`, scope `convex`, one log record per
  event with `timeUnixNano`, `severityText` / `severityNumber` (console levels; ERROR for a failed function;
  INFO otherwise), the event JSON as the string body, and `convex.*` attributes (topic, function path and
  type, …).
- Batches of 400. Verification is `POST <host>/decide?v=3` with `{api_key, distinct_id}`, a single attempt,
  failures prefixed `Failed to verify PostHog project token: `.

### 1.6 PostHog Error Tracking

- `POST <host>/i/v0/e/` with `{api_key, batch: [$exception captures]}`, batches of 100; only exceptions.
- A capture: `event: "$exception"`, `distinct_id` (the deployment), an RFC 3339 timestamp, and properties:
  `$exception_list` (type, value, `mechanism {handled: false, type: "generic"}`, raw stack frames),
  `$exception_level`, `$exception_types`, `$lib`, and `convex_*` properties (function, type, runtime,
  deployment, request id).

## 2. What an app can observe

- A stream of each type becomes active and its service receives the deployment's events (or exceptions)
  with Convex's payloads.
- The failure reasons on `get_log_stream`.
- The names inside the payloads: where Convex says `convex` (Datadog's `ddsource`, the metadata key,
  Sentry's SDK and context, PostHog's attributes and properties, the User-Agent), bunvex says `bunvex`
  (DV-304).

## 3. How bunvex does it

- `log-sink-http.ts`: what every HTTP sink shares (the interface, `EgressFailure`, the canonical reason
  phrases, backoff, the filters, `postWithRetry`).
- `log-sinks-providers.ts`: one class per provider, each with Convex's URL, headers, payload, batching,
  attempts, verification and filter; the Sentry DSN parser is shared with the API's `InvalidSentryDsn`
  check.
- The exception event now carries what Sentry and PostHog need: the parsed stack frames, the
  `BunvexError` data, the caller's token identifier and IP, the runtime (this resolves DV-305's frames).
- The version in Sentry's `sdk.version` / `sentry_client` is `unknown`, Convex's fallback when no version
  is set.
- **Measured:** building Datadog batches costs about 76 ns per event (100 000 events in 7.6 ms), so the
  sinks' cost is the network.

## 4. Divergences

- DV-303 is resolved: the five sinks start and send as Convex's.
- DV-304 now also covers the provider payloads' names (`bunvex` for `convex`), as the owner decided.
- No other: the payload structures, limits, attempts and failure texts are Convex's.

## 5. Tests

`packages/server/test/log-sinks-providers.test.ts`, through the whole pipeline (a stream created over the
API, functions that log and fail) against a `fetch` that records each request: Datadog's URL, headers,
wrapper, batching and failures; Axiom's URLs, auth and sorted attributes; Sentry's envelope, auth, event,
frame order, ignored status and 429; PostHog's `/decide`, OTLP records and `$exception` captures.

Sabotage checks (each made a test fail): `ddsource`; Axiom's attribute sort; PostHog's WARN severity;
Sentry's 429 pause; the frame order; commas and bytes (not characters) in batch sizes; Sentry's and
PostHog Error Tracking's exception-only filters.

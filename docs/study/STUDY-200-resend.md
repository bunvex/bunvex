# STUDY-200 — `@bunvex/resend`
<!-- index: `@bunvex/resend`, the fifth own component (STUDY-158's list extended) and the email sender of built-in auth (STUDY-191 A-7): a queue of emails sent in batches to Resend's API through two workpools and a rate limiter, webhooks verified with Svix signatures, statuses and delivery events, cleanups; written from get-convex/resend 0.2.10 | open: R-1–R-8 -->

- **Status:** open, waiting for the owner on R-1–R-8 (§7).
- **Convex source read:** get-convex/resend (now github.com/convex/resend) at `982bc63` (the tag commit of 0.2.10,
  2026-10-22), cloned at `../resend`. Paths are relative to that repository's root. R-1 pins it.
- **Consumer read:** Convex Auth v2 at `84ccfa8d` (`../convex-auth`), `packages/core` (§1.15).
- **Dependencies inspected from npm tarballs** (the lockfile's versions): `svix` 1.96.1, `standardwebhooks` 1.0.0,
  `resend` 6.17.2, `remeda` 2.39.0; run under Bun 1.4.4 (§1.14).
- **bunvex source:** `main`, with `@bunvex/workpool` (STUDY-199), `@bunvex/rate-limiter` (STUDY-197) and
  `@bunvex/batch-worker` (STUDY-196).
- **Scope:** the component auth's email method needs (STUDY-191 A-7, decided: write `@bunvex/resend` with Convex's
  API). The owner chose the order workpool → resend → auth (2026-10-29).
- **Related:**
  - [STUDY-158](STUDY-158-own-components.md): the model for bunvex's own components, DV-538, DV-539;
  - [STUDY-191](STUDY-191-convex-auth-v2.md): A-7, the email method;
  - [STUDY-199](STUDY-199-workpool.md), [STUDY-197](STUDY-197-rate-limiter.md): its children.

## 1. How Convex does it

### 1.1 The package (`package.json`)

- **Name** `@convex-dev/resend`, version `0.2.10`, `"type": "module"`, Apache-2.0, `files: ["dist", "src"]`.
  Description "A resend component for Convex.", keywords `convex`, `component`; `repository: github:convex/resend`,
  `homepage` on github.com/convex/resend, `bugs.email: support@convex.dev`.
- **Exports:**
  - `.` → `dist/client/index.js` (types `dist/client/index.d.ts`): the client (`src/client/index.ts`);
  - `./convex.config` and `./convex.config.js` → `dist/component/convex.config.js`;
  - `./_generated/component.js` → types only (`ComponentApi`). Convex Auth imports this one (§1.15);
  - `./test` → `./src/test.ts` (source, Vite's `import.meta.glob`);
  - `./package.json`.
- **Dependencies** (regular, so an app gets them transitively), with what the lockfile resolved:

| Package | Range | Lock | Used by shipped code for |
|---|---|---|---|
| `@convex-dev/rate-limiter` | `^0.3.0` | 0.3.2 | the child `rateLimiter` and one fixed-window limit (§1.7). `^0.3.0` excludes 0.4.x |
| `@convex-dev/workpool` | `^0.4.10` | 0.4.10 (a fresh install gets 0.4.14) | the children `emailWorkpool`, `callbackWorkpool` (§1.6–§1.8) |
| `remeda` | `^2.26.0` | 2.39.0 | `isDeepEqual` only (`src/component/lib.ts:25,413`) |
| `resend` (the SDK) | `^6.6.0` | 6.17.2 | **nothing**: no file under `src/` imports it. Only `example/convex/example.ts:9` and the README's `sendEmailManually` recipe |
| `svix` | `^1.70.0` | 1.96.1 | `Webhook` (`verify`) in `handleResendEventWebhook` (`src/client/index.ts:10,478-487`) |

- **Peer dependencies:** `convex ^1.43.0`, `convex-helpers ^0.1.106` (lock 0.1.128). convex-helpers use:
  `omit` (root, `lib.ts:27,372,396`), `parse` (`convex-helpers/validators`, `lib.ts:28,654`, `utils.ts:1,18`),
  `literals` (`shared.ts:1,160`).
- **devDependencies** worth knowing: `convex` 1.46.0, `convex-test` 0.0.62 (`defineTestApp`), `vitest` 5.0.0,
  `@edge-runtime/vm` 5.0.0, `react`/`react-dom` 19 (types only). CI: Node 24 (`.github/workflows/test.yml`).
- **CHANGELOG 0.2.x**: 0.2.0 static component API, `/test` and `/_generated/component.js` entry points, ESM only;
  0.2.1 templates and multiple recipients; 0.2.3 webhooks work for manual-only users (the `lastOptions` null guard,
  §1.10); 0.2.4 `sendEmailManually` keeps `cc`/`bcc`; 0.2.5 `ActionCtx` accepted by the client; 0.2.6
  `message_id` forwarded in events; 0.2.7 workpool bump; 0.2.8 `idempotencyKey`; 0.2.9 `/test` for
  `defineTestApp`; 0.2.10 `/test` registers the children (#127).

### 1.2 The component (`src/component/convex.config.ts`)

- `defineComponent("resend")`, three children:
  - `component.use(rateLimiter)` → mounted as `rateLimiter`;
  - `component.use(workpool, {name: "emailWorkpool"})`;
  - `component.use(workpool, {name: "callbackWorkpool"})`.
- No `env` of its own, no HTTP routes, no crons. Everything it needs comes in as arguments (`options`, §1.4).
- Pools are configured from code at each enqueue (`lib.ts:74-81`): both `maxParallelism: 4` (`EMAIL_POOL_SIZE`,
  `CALLBACK_POOL_SIZE`), no `logLevel`, no default retry on the class.
- On Convex, with the locked 0.3.2, `resend/rateLimiter` has **no** child (0.4.0 added `batchWorker` and the
  `pendingUpdates` table; `git -C ../rate-limiter diff v0.3.2 v0.4.2 -- src/component/convex.config.ts`).

### 1.3 Constants (`src/component/lib.ts:31-42`, `src/client/index.ts:43-51`)

| Name | Value | Use |
|---|---|---|
| `SEGMENT_MS` | 125 ms | `getSegment(now) = floor(now / 125)` (`:69-71`) |
| `BASE_BATCH_DELAY` | 1000 ms | delay of the batcher's first and idle runs |
| `BATCH_SIZE` | 100 | emails per Resend batch call (Resend's batch maximum) |
| `EMAIL_POOL_SIZE`, `CALLBACK_POOL_SIZE` | 4, 4 | pools' `maxParallelism` |
| `RESEND_ONE_CALL_EVERY_MS` | 600 ms | the fixed window (comment: "Half the stated limit") |
| `FINALIZED_EMAIL_RETENTION_MS` | 7 days | `cleanupOldEmails` default |
| `FINALIZED_EPOCH` | `Number.MAX_SAFE_INTEGER` | `finalizedAt` of an email not finalized |
| `ABANDONED_EMAIL_RETENTION_MS` | 30 days | `cleanupAbandonedEmails` default |
| `FIXED_WINDOW_DELAY` | 100 ms | max jitter added to a rate-limited batch (`:749`) |
| `RESEND_TEST_EMAILS` | `delivered`, `bounced`, `complained` | test-mode local parts (`:42`) |
| `PERMANENT_ERROR_CODES` | 400, 401, 403–408, 410, 411, 413–416, 418, 421, 422, 426, 427, 428, 431 | HTTP statuses not retried (`:59-66`). Not in it, so retried: 402, 409, 412, 417, 423–425, **429**, 451, every 5xx |
| client defaults | `apiKey: process.env.RESEND_API_KEY ?? ""`, `webhookSecret: process.env.RESEND_WEBHOOK_SECRET ?? ""`, `initialBackoffMs: 30000`, `retryAttempts: 5`, `testMode: true` | `getDefaultConfig` |

### 1.4 The schema (`src/component/schema.ts`) and shared validators (`src/component/shared.ts`)

- **`emails`** — one row per email:
  - `from: string`; `to: string[] | string` (a string only in old rows; every writer stores an array);
    `cc?`, `bcc?: string[]`; `subject?: string`; `replyTo: string[]` (`[]` by default);
  - `html?`, `text?: Id<"content">` (the bodies live in `content`);
  - `template?: {id: string, variables?: Record<string, string | number>}` (`vTemplate`, `shared.ts:29`);
  - `headers?: {name, value}[]`;
  - `status: vStatus` (`shared.ts:16`): `waiting | queued | cancelled | sent | delivered | delivery_delayed |
    bounced | failed`;
  - flags: `complained: boolean`, `opened: boolean`, `bounced?`, `failed?`, `deliveryDelayed?`, `clicked?:
    boolean` (optional ones from older versions; every writer sets them `false`);
  - `errorMessage?: string`; `resendId?: string` (Resend's id, set when sent); `idempotencyKey?: string` (0.2.8);
  - `segment: number` (send-request segment; `Infinity` for manual emails); `finalizedAt: number`
    (`MAX_SAFE_INTEGER` until final).
  - Indexes: `by_status_segment [status, segment]`, `by_resendId [resendId]`, `by_idempotencyKey
    [idempotencyKey]`, `by_finalizedAt [finalizedAt]`.
- **`content`** — `{content: bytes, mimeType: string, filename?: string, path?: string}`. Written with
  `TextEncoder().encode(body).buffer` and `mimeType` `text/html` or `text/plain`. `filename` and `path` are never
  written (attachment fields that were never wired up).
- **`deliveryEvents`** — `{emailId: Id<"emails">, resendId: string, eventType: vEventType, createdAt: string,
  message?: string}`, index `by_emailId_eventType [emailId, eventType]`. One row per accepted webhook event,
  duplicates included. `createdAt` is the event's own `created_at` (ISO string).
- **`lastOptions`** — one row `{options: vOptions}`; `vOptions` (`shared.ts:36`) is `{initialBackoffMs: number,
  retryAttempts: number, apiKey: string, testMode: boolean, onEmailEvent?: {fnHandle: string}}`. The last caller's
  options, used by the batcher (API key, retries) and by the webhook path (callback). The API key sits here in
  plain text.
- **`nextBatchRun`** — one row `{runId: Id<"_scheduled_functions">}`: "a batcher is running". Only its existence
  is read; `runId` is the first scheduled run's id and is never updated (§2.3).
- **`vEmailEvent`** (`shared.ts:79-147`): a union of 8 objects `{type, created_at: string, data}`, `data` being
  `commonFields` (`:46-77`: `broadcast_id?`, `created_at`, `email_id`, `from` and `to` as string or string[],
  `cc?`/`bcc?`/`reply_to?` as string or string[], `message_id?` (0.2.6), `headers?: {name, value}[]`, `subject:
  string`, `tags?` as a string record or `{name, value}[]`) plus, per type: `email.bounced` → `bounce: {message,
  subType, type}`; `email.opened` → `open: {ipAddress, timestamp, userAgent}`; `email.clicked` → `click:
  {ipAddress, link, timestamp, userAgent}`; `email.failed` → `failed: {reason}`. Types: `email.sent`,
  `email.delivered`, `email.delivery_delayed`, `email.complained`, `email.bounced`, `email.opened`,
  `email.clicked`, `email.failed` (`ACCEPTED_EVENT_TYPES`, `:149`). All fields are strict strings: a `null` in a
  Resend payload fails the parse (unconfirmed whether Resend sends nulls).
- **Status machine** (writers in parentheses):
  - `waiting` (`sendEmail`) → `queued` (`makeBatch`) → `sent` (`onEmailComplete` success, with `resendId`);
  - `waiting`/`queued` → `cancelled` (`cancelEmail`; also `onEmailComplete` kind `canceled` for still-`queued`
    rows, `errorMessage: "Resend API batch job was cancelled"`);
  - `queued` → `failed` (`markEmailsFailed` on a permanent HTTP error, or `onEmailComplete` kind `failed` after
    the retries);
  - manual: `queued` (`createManualEmail`) → `sent` / `failed` (`updateManualEmail`, which accepts any status);
  - webhooks only move up a rank (`computeEmailUpdateFromEvent`, `lib.ts:816-831`): `waiting 0 < queued 1 < sent 2 <
    delivery_delayed 3 < delivered 4 < bounced 5 = failed 5`, `cancelled` terminal (100). So `delivered` after
    `bounced` is ignored, `failed` after `bounced` keeps `bounced`.
  - `finalizedAt = Date.now()` on: cancel, `failed` (any path), `delivered`, `bounced` (status change only),
    `complained` (only if not yet finalized), `updateManualEmail` to `failed`/`cancelled`. **Not** on `sent` or
    `delivery_delayed`.

### 1.5 The component's functions (`src/component/lib.ts`)

Public (callable by the parent; `_generated/component.ts` types all as `"internal"` visibility from the app):

| Function | Kind | Args → returns | What it does |
|---|---|---|---|
| `sendEmail` | mutation | `{options: vOptions, from, to: string[], cc?, bcc?: string[], subject?, html?, text?, template?: vTemplate, replyTo?: string[], headers?: {name,value}[], idempotencyKey?}` → `Id<"emails">` | §1.6 |
| `createManualEmail` | mutation | `{from, to: string \| string[], cc?, bcc?: string \| string[], subject: string, replyTo?, headers?}` → `Id<"emails">` | inserts `status: "queued"`, `segment: Infinity`, flags false, `replyTo ?? []`, arrays normalized (`:239-278`). No test-mode check, no `lastOptions` write |
| `updateManualEmail` | mutation | `{emailId, status: vStatus, resendId?, errorMessage?}` → null | patches `status`, `resendId`, `errorMessage` (an absent one is removed by the patch); `finalizedAt` when `failed`/`cancelled` (`:285-305`) |
| `cancelEmail` | mutation | `{emailId}` → null | throws `Email not found`; throws `Email has already been sent` unless `waiting`/`queued`; else `cancelled` + `finalizedAt` (`:309-327`). No event, no callback |
| `getStatus` | query | `{emailId}` → `{status, errorMessage: string\|null, bounced, complained, failed, deliveryDelayed, opened, clicked}` or null | optional flags default `false` (`:330-363`) |
| `get` | query | `{emailId}` → the row without `_id`, `_creationTime`, `html`, `text`, plus `createdAt` (= `_creationTime`), `html?`/`text?` decoded strings, `to` always an array; or null | returns `segment`, `idempotencyKey`, `finalizedAt`, `template` too (the validator is built from `schema.tables.emails.validator.fields`, `:366-403`). A missing content row decodes to `""` |
| `handleEmailEvent` | mutation | `{event: any}` → null | §1.9 |
| `cleanupOldEmails` | mutation | `{olderThan?: number}` → null | §1.11 |
| `cleanupAbandonedEmails` | mutation | `{olderThan?: number}` → null | §1.11 |

Internal: `makeBatch` (mutation, `{reloop: boolean, segment: number}`), `callResendAPIWithBatch` (action,
`{apiKey, emails: Id<"emails">[]}` → `null | {emailIds, resendIds}`), `markEmailsFailed` (mutation),
`onEmailComplete` (workpool `defineOnComplete`, context `{emailIds}`), `getAllContentByIds`, `getEmailsByIds`,
`getEmailByResendId` (query, unused; throws `Email not found for resendId`). Paths a scheduled job or workpool
row in an export may name: `lib:makeBatch`, `lib:cleanupOldEmails`, `lib:cleanupAbandonedEmails`,
`lib:callResendAPIWithBatch`, `lib:onEmailComplete`.

### 1.6 Enqueue: `sendEmail` (`lib.ts:123-237`) and the batcher (`:406-533`)

- **Order of checks** in `sendEmail`:
  1. `idempotencyKey` given and a row with it exists (`by_idempotencyKey`, `.first()`) → return that id. No
     other check, whatever the other args or that row's status. Dedupe lasts until the row is cleaned up.
  2. `options.testMode` → every `to`, `cc`, `bcc` must pass `isTestEmail` (`:44-58`): split on `@`, the second
     part must be exactly `resend.dev`, the first equal to `delivered`/`bounced`/`complained` or start with it plus
     `+`. Else throws `Test mode is enabled, but email address is not a valid resend test address. Did you want to
     set testMode: false in your ResendOptions?`. `from` and `replyTo` are not checked. Case-sensitive; a display
     name (`"X <delivered@resend.dev>"`) fails.
  3. neither `html`/`text` nor `template?.id` → `Either html/text or template must be provided`; both →
     `Cannot provide both html/text and template`; no template and no `subject` → `Subject is required when not
     using a template`. An empty string counts as content.
- Inserts one `content` row per body, then the email: `status: "waiting"`, `segment: getSegment(Date.now())`,
  all flags `false`, `replyTo ?? []`, `finalizedAt: MAX_SAFE_INTEGER`.
- **`scheduleBatchRun`**: `lastOptions` inserted if absent, `replace`d if `!isDeepEqual(stored, options)` (so the
  last caller's options win for every email still waiting, and the onEmailEvent handle with them). Then if a
  `nextBatchRun` row exists, done; else `scheduler.runAfter(1000, makeBatch, {reloop: false, segment:
  getSegment(now + 1000)})` and insert `nextBatchRun {runId}`. `.unique()` on both singleton tables.
- **`makeBatch`**:
  - reads `lastOptions` (throws `No last options found -- invariant` if none);
  - takes ≤ 100 `waiting` emails with `segment ≤ args.segment - 2` (two segments, 250 ms, of slack against
    concurrent inserts);
  - none, or `reloop` and fewer than 100 → `reschedule`: if any `waiting` email exists (any segment) →
    `runAfter(1000, makeBatch, {reloop: false, segment: getSegment(now + 1000)})`; else delete the
    `nextBatchRun` row (throws `No batch run found -- invariant` if missing): the batcher goes idle;
  - else logs `Making a batch of <n> emails`, patches them `queued`, computes `delay = getDelay()` (§1.7) and
    `emailPool.enqueueAction(callResendAPIWithBatch, {apiKey: options.apiKey, emails: ids}, {retry: {maxAttempts:
    options.retryAttempts, initialBackoffMs: options.initialBackoffMs, base: 2}, runAfter: delay, context:
    {emailIds}, onComplete: internal.lib.onEmailComplete})`, then `runAfter(0, makeBatch, {reloop: true, segment:
    args.segment})`.
  - Effect: the first email after idle goes out ≈ 1 s later; a full batch is followed at once by the next; a short
    batch on a reloop waits 1 s.
- **Retries are the workpool's**: `maxAttempts = retryAttempts` counts *all* attempts (workpool retries while
  `attempts < maxAttempts`, STUDY-199 §1.11), so the default 5 is 1 try + 4 retries and `retryAttempts: 0` is a
  single try. Backoff `initialBackoffMs × 2^(n-1) × (0.5 + random)`: ≈ 30 s, 60 s, 120 s, 240 s by default.

### 1.7 Rate limiting (`lib.ts:85-91`, `:749-757`)

- One limit on the child: `resendApi: {kind: "fixed window", period: 600, rate: 1}` (no `capacity`, `shards`,
  `start`, `maxReserved`), via the `RateLimiter` client.
- `getDelay` (in `makeBatch`'s transaction): `limit(ctx, "resendApi", {reserve: true})`; no `maxReserved`, so it
  always succeeds; `delay = retryAfter ? retryAfter + Math.random() × 100 : 0`. So batch calls are spaced ≥ 600 ms
  apart across the deployment, by reservation (queue time), not by refusal.
- No key, so one global window. A fixed window without `start` gets a random phase when its row is first written
  (STUDY-197 §1.2).
- Nothing reads Resend's `429` / `Retry-After`: a 429 is a transient error retried with the workpool backoff.

### 1.8 Sending: `callResendAPIWithBatch` (`lib.ts:555-615`, payload `:691-747`)

- **Reads** the emails (`getEmailsByIds`, drops missing rows) and keeps only `status === "queued"` (cancelled ones
  drop out). None left → logs `No emails to send in batch. All were cancelled or failed.` and returns (null).
- **Bodies** via one `getAllContentByIds` query (throws `Content not found -- invariant`).
- **Request:** `fetch("https://api.resend.com/emails/batch", {method: "POST", headers: {Authorization: "Bearer
  <apiKey>", "Content-Type": "application/json", "Idempotency-Key": <args.emails[0]>}, body})`. The idempotency key
  is the *first id of the batch as enqueued* (not of the filtered list), the same on every retry. No timeout, no
  `User-Agent` of its own (Convex's fetch sends `Convex/1.0`).
- **Body:** `JSON.stringify` of an array, one object per kept email: `from`, `to` (array), `bcc`, `cc`,
  `reply_to` (always an array, `[]` when none), `headers` (an object from the `{name, value}` list; a repeated
  name keeps the last), then either `template: {id, variables?}` plus `subject` if truthy, or `subject`, `html`,
  `text`. `undefined` keys vanish in the JSON. No `tags`, `attachments`, `scheduled_at`, `x-batch-validation`.
- **Response:**
  - `ok` and `data.data` present → returns `{emailIds: <kept ids>, resendIds: data.data.map(d => d.id)}` (by
    position);
  - `ok` without `data` → throws `Resend API error: No data returned` (retried);
  - status in `PERMANENT_ERROR_CODES` → `errorMessage = "Resend API error: <status> <statusText> <body text>"`,
    `console.error` of `JSON.stringify({status: "permanent_failure", httpStatus, httpStatusText, errorMessage,
    emailIds})`, `markEmailsFailed({emailIds: args.emails, errorMessage})` (only rows still `queued` → `failed`,
    `finalizedAt`), returns (null): the workpool sees success;
  - any other status → throws `Resend API error: <body text>` (retried; a network failure throws the platform's
    `TypeError`, retried too).
- **`onEmailComplete`** (`:648-688`):
  - `success` → `parse(vBatchReturns, returnValue)`; null → nothing; else patch each returned id `status: "sent"`,
    `resendId` (unconditionally, even if it was cancelled after the payload was built);
  - `failed` → `markEmailsFailedHandler` with `errorMessage = result.error` (the workpool's text of the last
    error, see STUDY-199 §2.3 on its exact form) for rows still `queued`;
  - `canceled` (only if someone cancels the workpool job; resend never does) → still-`queued` rows `cancelled`,
    `errorMessage: "Resend API batch job was cancelled"`, `finalizedAt`.

### 1.9 Webhooks (`src/client/index.ts:471-497`, `lib.ts:811-1011`)

- The app mounts the route itself (`example/convex/http.ts`, README): `http.route({path: "/resend-webhook", method:
  "POST", handler: httpAction((ctx, req) => resend.handleResendEventWebhook(ctx, req))})`.
- **`handleResendEventWebhook(ctx, req)`** (client, runs in the app's HTTP action):
  1. `webhookSecret === ""` → throws `Webhook secret is not set`;
  2. `new Webhook(secret)` (svix), `raw = await req.text()`, headers `svix-id`, `svix-timestamp`,
     `svix-signature` (missing → `""`), `webhook.verify(raw, …)` — throws on failure (§1.14 for the messages);
  3. `ctx.runMutation(component.lib.handleEmailEvent, {event: <the parsed JSON>})`;
  4. returns `new Response(null, {status: 201})`.
  Any throw (no secret, bad signature, stale timestamp, bad JSON, a throwing mutation) escapes the HTTP action:
  the platform's 500. No 4xx is ever returned. Resend retries non-2xx deliveries (Resend's policy, unconfirmed
  details).
- **`handleEmailEvent({event: any})`**:
  1. `attemptToParse(vEmailEvent, event)` (convex-helpers `parse`: validates allowing unknown fields, then
     strips them). Failure → `console.warn("Invalid email event received. You might want to to exclude this event
     from your Resend webhook settings in the Resend dashboard. <error>.")` and return. Event types outside the 8
     (e.g. `contact.*`, `domain.*`, newer `email.*`) land here.
  2. Email by `by_resendId` `.unique()` (throws if two rows share it). None → `console.info("Email not found for
     resendId: <id>, ignoring...")` and return (no row, no callback).
  3. Inserts a `deliveryEvents` row (always: the type is one of the accepted ones), `message` = `bounce.message`
     or `failed.reason`.
  4. `computeEmailUpdateFromEvent` → `replace` only on a change:
     - `email.sent`: nothing (status set by `onEmailComplete`);
     - `email.clicked` / `email.opened`: flag `true` on the first one;
     - `email.failed`: `failed: true`; status `failed` + `finalizedAt` if it outranks;
     - `email.delivered`: status `delivered` + `finalizedAt` if it outranks;
     - `email.bounced`: `bounced: true`, `errorMessage = bounce.message`; status `bounced` + `finalizedAt` if it
       outranks;
     - `email.delivery_delayed`: `deliveryDelayed: true`; status `delivery_delayed` if it outranks;
     - `email.complained`: `complained: true`, `finalizedAt` if still `MAX_SAFE_INTEGER`; status unchanged.
     Flags are set even on a `cancelled` email.
  5. **Callback** (`enqueueCallbackIfExists`): reads `lastOptions` (absent → none, the manual-only case of 0.2.3);
     if `options.onEmailEvent` → `callbackPool.enqueueMutation(ctx, fnHandle, {id: email._id, event})` with the
     *parsed* event. Fires for every valid event with a matching email, duplicates and no-change events included.
     Mutations are not retried by the workpool; its failure is only logged.

### 1.10 The client (`src/client/index.ts`)

- **Exports:** `Resend` (class), `ResendComponent` (= `ComponentApi`), `EmailId` (branded string), `vEmailId`
  (`v.string()` typed as `EmailId`), `vOnEmailEventArgs = v.object({id: vEmailId, event: vEmailEvent})`, re-exports
  `vEmailEvent`, `vOptions`, `vStatus`, `vTemplate`, types `EmailEvent`, `Status`, `Template`, `ResendOptions`,
  `EmailStatus`, `SendEmailOptions`. Not exported: `RuntimeConfig`, `vEventType`, `ACCEPTED_EVENT_TYPES`.
- **`new Resend(component, options?)`**: `config = {apiKey, webhookSecret, initialBackoffMs, retryAttempts,
  testMode}`, each `options.x ?? default` (§1.3); `process.env` is read in the constructor, so usually at module
  load. `onEmailEvent` kept if truthy. `config` and `component` are public fields (the key is readable). No
  validation at construction.
- **`ResendOptions`**: `apiKey?`, `webhookSecret?`, `initialBackoffMs?`, `retryAttempts?`, `testMode?`,
  `onEmailEvent?: FunctionReference<"mutation", any visibility, {id: EmailId, event: EmailEvent}> | null`.
  No base URL, no rate option, no pool sizes.
- **`sendEmail(ctx, options)`** (and a deprecated positional overload `sendEmail(ctx, from, to, subject, html?,
  text?, replyTo?, headers?)`): throws `API key is not set` if `apiKey === ""`; then `ctx.runMutation(lib.sendEmail,
  {options: <runtime config>, ...args, to: array, cc/bcc: arrays})`. The runtime config is `{apiKey,
  initialBackoffMs, retryAttempts, testMode, onEmailEvent: {fnHandle: await createFunctionHandle(ref)} |
  undefined}` — a handle is created on every call. `SendEmailOptions` is a union: `{from, to: string | string[],
  cc?, bcc?, subject: string, html?, text?, replyTo?: string[], headers?, idempotencyKey?}` or the template form
  (`subject?`, `template: {id, variables?}`, `html?/text?: never`). An extra key (e.g. `attachments`) is spread
  through and refused by the mutation's validator. Works from a mutation or an action (each call its own
  mutation in an action). Returns the id as `EmailId`.
- **`sendEmailManually(ctx, {from, to, cc?, bcc?, subject, replyTo?, headers?}, sendCallback: (emailId) =>
  Promise<string>)`**: `createManualEmail`; awaits the callback (the app sends with whatever it wants, e.g. the
  `resend` SDK with `Idempotency-Key: emailId`); `updateManualEmail({status: "sent", resendId})`; on a throw,
  `updateManualEmail({status: "failed", errorMessage: e.message ?? String(e), resendId: e.resendId if a
  string})` and rethrows. No API-key check. The only route for attachments.
- **`cancelEmail(ctx, emailId)`**, **`status(ctx, emailId)`** (`EmailStatus | null`), **`get(ctx, emailId)`**:
  thin `runMutation`/`runQuery` wrappers; `status`/`get` take a query ctx too.
- **`handleResendEventWebhook(ctx, req)`**: §1.9.
- **`defineOnEmailEvent(handler)`**: `internalMutationGeneric({args: {id: vEmailId, event: vEmailEvent},
  handler})`, no `returns`.
- **`./test`** (`src/test.ts`): `register(t, name = "resend")` registers `${name}/rateLimiter`,
  `${name}/emailWorkpool`, `${name}/callbackWorkpool` and returns `t.registerComponent(name, schema, modules)`;
  default export `{register, schema, modules}`.

### 1.11 Cleanup (`lib.ts:95-119`, `:1013-1057`)

- **`cleanupOldEmails({olderThan = 7 days})`**: ≤ 100 emails with `finalizedAt < now - olderThan`; each removed
  with its `content` rows and all its `deliveryEvents`; logs `Cleaned up <n> emails` when n > 0; if exactly 100,
  `runAfter(0, api.lib.cleanupOldEmails, {olderThan})`. Never touches unfinalized rows (`sent`,
  `delivery_delayed`, `waiting`, `queued`).
- **`cleanupAbandonedEmails({olderThan = 30 days})`**: ≤ 500 emails by `by_creation_time` with `_creationTime <
  now - olderThan`, **any status** (also `waiting`/`queued`), same deletion and log, reschedules at 500.
- **No crons in the component.** The app schedules them (README / `example/convex/crons.ts`: an hourly
  `crons.interval` calling an app `internalMutation` that `runAfter(0, components.resend.lib.cleanup…)`).
  README says "If you pass no argument, it defaults to deleting emails older than 7 days" — true of
  `cleanupOldEmails` only.
- Nothing cleans orphan `content` rows, `lastOptions`, the rate limiter or the pools' tables.

### 1.12 Errors and log lines

No `ConvexError` anywhere; every throw is a plain `Error`.

| Where | Message |
|---|---|
| client `sendEmail` | `API key is not set` |
| client `handleResendEventWebhook` | `Webhook secret is not set`; svix's `WebhookVerificationError`s (§1.14) |
| client `sendEmailManually` | rethrows the callback's error |
| `sendEmail` | `Test mode is enabled, but email address is not a valid resend test address. Did you want to set testMode: false in your ResendOptions?`; `Either html/text or template must be provided`; `Cannot provide both html/text and template`; `Subject is required when not using a template` |
| `cancelEmail` | `Email not found`; `Email has already been sent` |
| `makeBatch` / `reschedule` | `No last options found -- invariant`; `No batch run found -- invariant` |
| `callResendAPIWithBatch` | `Resend API error: <body>`; `Resend API error: No data returned` |
| `getAllContentByIds` | `Content not found -- invariant` |
| `getEmailByResendId` (unused) | `Email not found for resendId` |
| `assertExhaustive` (`utils.ts:4`) | `Unhandled event type: <value>` (unreachable) |
| stored `errorMessage` | `Resend API error: <status> <statusText> <body>`; `Resend API batch job was cancelled`; the workpool's failure text; a bounce message; a manual callback's `e.message` |

| Level | Line |
|---|---|
| log | `Cleaned up <n> emails` (both cleanups); `Making a batch of <n> emails`; `No emails to send in batch. All were cancelled or failed.` |
| error | `{"status":"permanent_failure","httpStatus":…,"httpStatusText":…,"errorMessage":…,"emailIds":[…]}` |
| warn | `Invalid email event received. You might want to to exclude this event from your Resend webhook settings in the Resend dashboard. <ValidationError>.` (the doubled "to" is upstream's) |
| info | `Email not found for resendId: <id>, ignoring...` |

Plus the children's own lines (workpool's leveled logs, STUDY-199 §1.13).

### 1.13 Its tests

| File | Covers |
|---|---|
| `src/component/setup.test.ts` | `convexTest(schema, modules)` helpers: `createTestEventOfType` (one fixture per event type), `createTestRuntimeConfig`, `setupTestLastOptions`, `insertTestEmail`, `insertTestSentEmail`; a trivial `setup` test |
| `src/component/lib.test.ts` (24 cases) | `handleEmailEvent`: each event type's update and `deliveryEvents` row (delivered, complained, bounced, delivery_delayed, opened, sent no-op, clicked, failed), five malformed inputs (no `type`, no `data`, garbage, `null`, `{}`) handled without throwing; `vEmailEvent` parse keeps `message_id` and strips unknown fields; `sendEmail` with templates (accept, both → error, optional subject, neither → error, no subject → error); `idempotencyKey` (persisted, duplicate returns the same id, distinct keys, no key no dedupe); `createManualEmail` keeps `cc`/`bcc` |
| `src/component/utils.test.ts` (4) | `isValidResendTestEmail` — a stricter regex (`^(delivered\|bounced\|complained)(\+[a-zA-Z0-9_-]*)?@resend\.dev$`) that **no shipped code calls**; `sendEmail` uses `isTestEmail` (§2.3) |
| `src/client/index.test.ts` (2, `test.each` over `resend`, `customResend`) | `defineTestApp` with the component mounted twice; `vi.stubGlobal("fetch")` returning `{data: [{id}]}`; `sendEmail` → `waiting` → `finishAllScheduledFunctions(vi.runAllTimers)` → `sent` with `resendId`; fetch called once with the batch URL and `POST`; a `delivered` event through `lib.handleEmailEvent` → `delivered` and the app callback row |
| `src/client/setup.test.ts` | `componentsGeneric()` typed as `{resend}`, module globs; trivial test |

Not tested upstream: the batcher's segment/reloop logic, rate-limit spacing, permanent vs transient HTTP handling,
`markEmailsFailed`, cancellation, cleanups, `get`/`getStatus` shapes, svix verification, `sendEmailManually`.
Network is never real: `fetch` is stubbed globally (convex-test runs actions in-process).

### 1.14 The third-party packages

- **`svix`** (1.96.1, CJS only, `main: dist/index.js`, one dependency `standardwebhooks` 1.0.0, which pulls
  `@stablelib/base64` and `fast-sha256`). Only `Webhook#verify` is used. Importing the package root loads the
  whole Svix API client too (bundle weight only). `verify` renames `svix-*` headers to `webhook-*` and calls
  standardwebhooks:
  - secret: `whsec_` prefix stripped, base64-decoded (a bad secret throws `Base64Coder: incorrect padding` or
    similar at construction);
  - missing header → `Missing required headers`; non-numeric timestamp → `Invalid Signature Headers`; more than
    300 s old → `Message timestamp too old`; more than 300 s ahead → `Message timestamp too new`;
  - signature = base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)); each space-separated `v1,<sig>` is
    compared in constant time; none matches → `No matching signature found`; else `JSON.parse(body)`.
  - All but the base64 one are `WebhookVerificationError` (`name` set). Verified under Bun 1.4.4 (scratch run):
    sign/verify round-trip, the four messages, and a WebCrypto `crypto.subtle` HMAC giving the identical
    signature. **Replaceable** by ~20 lines of WebCrypto (`importKey("raw", …, {name: "HMAC", hash: "SHA-256"})`,
    `sign`), keeping the same messages; the only observable would be the error class name/stack in a 500.
- **`resend` SDK** (6.17.2, deps `postal-mime`, `standardwebhooks`; `engines.node >= 20`): not imported by the
  component or client. It is a runtime dependency only so that apps following the README's
  `sendEmailManually` recipe find it installed (hoisted). Loads and constructs under Bun 1.4.4
  (`emails.send`, `batch.send` present; no network call tried). The component itself talks to Resend with plain
  `fetch`.
- **`remeda`**: `isDeepEqual(stored lastOptions, args.options)`. It compares key counts, so an `onEmailEvent:
  undefined` key matters; on Convex the args crossing `runMutation` lose `undefined` keys, so they compare equal
  and `lastOptions` is not rewritten on every send. Replaceable by a small structural compare.

### 1.15 What Convex Auth v2 uses (`../convex-auth` at `84ccfa8d`)

- `packages/core/package.json:522,541,547`: `@convex-dev/resend` `^0.2.8` as an **optional peer** and a
  devDependency; the example app pins `^0.2.6`.
- **The whole contract is `lib.sendEmail`**: auth never uses the `Resend` class, webhooks, status, cancel,
  `onEmailEvent`, templates, html, cc/bcc, replyTo, headers or `idempotencyKey`.
  - Type only: `ComponentApi` from `@convex-dev/resend/_generated/component.js`
    (`components/email/helpers.ts:9`); `SendEmailRef = ResendApi["lib"]["sendEmail"]` (`:177`) and a
    `FunctionHandle` of it (`:180-184`).
  - Args sent: `{options: {apiKey, testMode: false, initialBackoffMs, retryAttempts}, from, to: [address],
    subject, text}` (`helpers.ts:196-209`; `methods/email-password/server.ts:356-362`), `initialBackoffMs: 30000`,
    `retryAttempts: 5` (`server.ts:320-325`). The returned id is ignored.
  - Two call paths: (1) the app's auth mutations call `ctx.runMutation(components.resend.lib.sendEmail, …)`
    directly (security notifications, `notify`, `server.ts:345-363`); (2) the app makes
    `createFunctionHandle(components.resend.lib.sendEmail)` (`server.ts:333-339`) and passes the string as
    `sendEmailHandle` (`vEmailSenderConfig`, `components/email/validation.ts:176-186`) into the sibling component
    `authEmail`, which calls `ctx.runMutation(handle, …)` from inside itself (`helpers.ts:186-210`, from
    `challenge/common.ts:405`). So **a component calls a sibling component's mutation through a handle the app
    made**.
  - Mounting: `app.use(resend)` beside `auth`, `authEmail`, `authPassword`; `apiKey` from the typed
    `env.RESEND_API_KEY` of `defineApp({env: {RESEND_API_KEY: v.string(), …}})`
    (`examples/react-email-password/convex/{auth,convex.config}.ts`).
  - Tests replace resend with a stub component (`testing/resend.ts`, `testing/resendStub/{lib,schema}.ts`): its
    `lib.sendEmail` declares `{options: {apiKey, testMode, initialBackoffMs, retryAttempts}, from, to: string[],
    subject?, html?, text?}` → `v.string()` and records rows; `stubEmailSender` builds the handle and passes
    `retryAttempts: 0`, `initialBackoffMs: 0`.
- **Minimum contract for auth**: the component name/path `resend` + `lib:sendEmail`, those argument names and
  validators (an `options` object with exactly those four required fields, `onEmailEvent` optional), a string id
  back, `testMode: false` honoured, and the `./_generated/component.js` type export. Note: auth's sends overwrite
  `lastOptions` without `onEmailEvent`, so an app that also uses `new Resend(…, {onEmailEvent})` loses its
  webhook callbacks until its own next send (§2.3).

### 1.16 What resend needs from the platform, and bunvex's status

| Feature | Used at | bunvex |
|---|---|---|
| Children with `use(def, {name})`, two instances of one definition | `convex.config.ts` | supported: `packages/server/src/components.ts:31,141` (`UseOptions.name`) |
| `@convex-dev/workpool` client: `enqueueAction` with `retry`, `runAfter`, `context`, `onComplete`; `enqueueMutation` with a handle string; `defineOnComplete` | `lib.ts:74-81,481-498,648,1006` | supported: `components/workpool/src/client/index.ts:109,162,288`; a `function://` string is used as is (`:439`) |
| `@convex-dev/rate-limiter` **0.3.x** client `limit(ctx, name, {reserve: true})`, fixed window | `lib.ts:85,751` | the math and API are in `components/rate-limiter` (0.4.2 port); **the child's shape differs**: 0.4.2 has a `batchWorker` child and `pendingUpdates`, 0.3.2 has neither (§2.3) |
| `fetch` from a (non-Node) internal action, run by a workpool | `lib.ts:574` | supported: `packages/server/src/action-fetch.ts` (Convex's rules; `User-Agent: Bunvex/1.0`, DV-456); refused in queries/mutations (`packages/core/src/determinism.ts:365-368`) |
| `createFunctionHandle` in the app (client), stored as a string, called by a grandchild (`resend/callbackWorkpool`) | `index.ts:117`, `lib.ts:1006` | supported: `packages/server/src/function-handles.ts:185` (a handle passes through unchanged) |
| A sibling component calling `resend`'s `lib.sendEmail` by a handle the app made (auth) | §1.15 | supported in principle (handles name any function by id, `function-handles.ts:1-6`); not exercised by a bunvex test yet (unconfirmed) |
| `httpRouter` / `httpAction` in the app, `ctx.runMutation` into a component from an HTTP action, `req.text()`, `new Response(null, {status: 201})`, a throw → 500 | `example/convex/http.ts`, `index.ts:471-497` | supported: `packages/server/src/http-actions.ts` (500 body `{code, trace?, data?}`), `router.ts` |
| `process.env` read at module load in app code (client constructor) | `index.ts:45-46` | supported: `packages/server/src/env-scope.ts` (outside an execution, the version's load variables) |
| Typed `env` / `defineApp({env})` (auth's example) | §1.15 | supported: `components.ts:12-16,53-66` (STUDY-154) |
| `ctx.scheduler.runAfter` in a component (own internal and public functions), returning `Id<"_scheduled_functions">` stored in a table | `lib.ts:114,428,501,528,1052` | supported (batch-worker and workpool do it) |
| `v.id("_scheduled_functions")` in a component schema | `schema.ts:15` | supported: `components/batch-worker/src/component/schema.ts:25` |
| `v.bytes()` field with an `ArrayBuffer` from `TextEncoder`; `TextDecoder` in queries | `lib.ts:191,201,386,774` | supported: `packages/values/src/validators.ts:195` (bytes); TextEncoder/Decoder are Bun's |
| `Infinity` in a `number` field and in an index (`segment` of manual emails) | `lib.ts:265` | values and ordering support ±Infinity (`packages/values/src/value.ts:3`, `packages/values/test/sorting.property.test.ts:22`); an index range with an `Infinity` key not tested (unconfirmed) |
| table-first `db.get/patch/replace/delete(table, id)` | everywhere | supported (`components/workpool/src/component/danger.ts:31`, `loop.ts:214`) |
| `withIndex("by_creation_time", q => q.lt("_creationTime", t))` | `lib.ts:1039` | supported (`components/rate-limiter/src/component/lib.ts:118`) |
| `.unique()` / `.first()` / `.take(n)` / `.collect()` | — | supported |
| `schema.tables.emails.validator.fields` (for `get`'s `returns`) | `lib.ts:372` | supported (`packages/core/src/schema.ts:177`, STUDY-199 §1.17) |
| `Math.random()` (jitter) and `Date.now()` in a mutation | `lib.ts:755`, everywhere | supported (deterministic per execution) |
| convex-helpers `omit`, `parse` (strips unknown fields), `literals` | `lib.ts`, `utils.ts`, `shared.ts` | supported: `packages/helpers/src/index.ts:55`, `validators.ts:486` (strips), `:51` |
| `internalMutationGeneric`, `componentsGeneric` | client, `setup.test.ts` | supported: `packages/server/src/builders.ts:193`, `components.ts:280` |
| `console.log/info/warn/error` from component functions | §1.12 | supported (function logs) |
| Crons inside a component; system tables read directly; `ctx.meta`; `useStaleSnapshot` | — | not used by resend |
| Test harness: `defineTestApp`, `register` of nested children, `finishAllScheduledFunctions`, global `fetch` stub | `src/test.ts`, `src/client/index.test.ts` | **gap**: `@bunvex/testing` has no `defineTestApp` (as STUDY-199 §1.17). `fetch` in a bunvex action goes through core's wrapper, which captured the real `fetch` at install (`determinism.ts:226,374`); a test can inject a sender (`setFetchSender`, `determinism.ts:655-657`) — whether `bunvexTest` exposes it, unconfirmed |
| Third-party npm dependencies of a component (`svix`, `remeda`, `resend`) | `package.json` | **allowed**: `scripts/check-deps.ts` rule 1 restricts only `@bunvex/*` imports for components (`COMPONENT_ALLOWED` = `server`, `values`, `react`, `helpers`, `testing`, other components); any other bare import is accepted if the package declares it (`check-deps.ts:248-258`; otherwise `imports "<pkg>" but <name>/package.json does not declare it`). `packages/auth` already ships `jose`, `packages/server` `object-inspect`. No current component has a third-party dependency. Pushed code is bundled, so an app's `bunvex deploy` must bundle `svix` (CJS) for the function runtime (unconfirmed by a test; it runs under plain Bun) |

## 2. What an app can observe

STUDY-158 §2 applies. For resend:

### 2.1 The contract

- **The component:** name `resend`; children `rateLimiter`, `emailWorkpool`, `callbackWorkpool`; the five tables,
  their fields and indexes (§1.4), so a Convex export imports unchanged (`content.content` as bytes, `segment`
  `Infinity`, `finalizedAt` `MAX_SAFE_INTEGER`, `nextBatchRun.runId` a `_scheduled_functions` id); the nine
  public `lib` functions with their validators and results (§1.5); the internal paths a scheduled job or workpool
  row may name (`lib:makeBatch`, `lib:callResendAPIWithBatch`, `lib:onEmailComplete`, the cleanups).
- **The client:** `Resend`'s options and defaults (`testMode: true`, 30 s, 5 attempts, env names
  `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`), the overloads, `EmailId` as a plain string, the exported validators,
  `EmailStatus`, `get`'s shape (`createdAt`, decoded bodies, `to` array, extra fields).
- **The lifecycle and statuses** of §1.4, the rank rule, which events finalize, which flags each sets.
- **Timing:** first send ≈ 1 s after idle; 125 ms segments with a 2-segment lag; 100 per batch; one batch call per
  600 ms (+ ≤ 100 ms jitter) by reservation; workpool backoff; no Resend request before the batcher's delay.
- **The HTTP contract with Resend:** URL, method, headers (`Authorization`, `Content-Type`, `Idempotency-Key` =
  first email id), body shape (§1.8), which statuses are permanent.
- **The webhook contract:** `svix-*` headers, ±5 min tolerance, 201 with no body on success, 500 on any failure,
  unknown event types accepted with a warning, events for unknown `resendId` ignored.
- **Errors and logs** of §1.12 (messages an app catches or a log pipeline reads).

### 2.2 Corrections to earlier studies

- STUDY-199 (Scope) lists resend's two pools; resend also mounts `rateLimiter`, at 0.3.x.
- STUDY-191 §3.6 (line 251): "`authEmail` calls the sibling `resend` component's `sendEmail` by handle" — yes, and
  the app's auth mutations also call it directly by reference (`notify`).

### 2.3 Quirks an oracle will show

Each is what 0.2.10 does.

- **`lastOptions` is global and last-writer-wins.** Every `sendEmail` caller rewrites it; the batch uses the API
  key and retry settings of whoever called last, and the webhook callback follows the last caller's
  `onEmailEvent`. Auth's sends (no `onEmailEvent`) silence an app's callback until the app's next send.
- **`isTestEmail` is laxer than the README.** Any label after `+` is accepted (`delivered+foo.bar@resend.dev`
  passes), while the README and the tested `isValidResendTestEmail` allow only `[a-zA-Z0-9_-]`. A display-name
  address fails test mode. `a@b@resend.dev` fails (domain read as `b`).
- **Dedupe runs before every check**: a duplicate `idempotencyKey` returns the old id even with invalid addresses,
  other content, or a cancelled/failed original.
- **The Idempotency-Key is `emails[0]` of the enqueued batch.** If that email is cancelled while the batch waits
  for a retry, the next attempt sends a different payload under the same key; Resend then answers 409 (not
  permanent here, so retried until `failed`) — Resend's behaviour unconfirmed.
- **`cancelEmail` accepts `queued`**, but a cancel after the payload is built is overwritten to `sent` by
  `onEmailComplete`.
- **Webhooks before `onEmailComplete` are lost**: `resendId` is written only then, so an early `email.delivered`
  hits "Email not found for resendId" and never applies.
- **`nextBatchRun.runId` is stale**: set once per busy period, never updated by `reschedule`/reloop.
- **`retryAttempts` counts attempts, not retries** (5 → 4 retries; 0 → one try).
- **429 and 5xx are retried with the workpool backoff** (30 s+), not `Retry-After`. 409 too.
- **A permanent failure is a workpool success** (the action returns null); the email is `failed` with
  `Resend API error: <status> <statusText> <body>`. A retried failure's `errorMessage` is the workpool's text of
  the last thrown error (`Resend API error: <body>` or a fetch `TypeError`), whose exact form on Convex's backend
  may carry a prefix (unconfirmed, STUDY-199 §2.3).
- **`complained` finalizes without a status change** (a `sent` row becomes eligible for `cleanupOldEmails`);
  **`delivery_delayed` never finalizes**; `sent` rows are only removed by `cleanupAbandonedEmails`.
- **`cleanupAbandonedEmails` deletes any status**, including emails still waiting to be sent; default 30 days,
  not the README's 7.
- **Flags change on cancelled emails** (opened, clicked, bounced…), and `bounced` overwrites `errorMessage`
  even when the status does not change.
- **Callback fires for every valid event**, including `email.sent` and repeats, with the parsed (field-stripped)
  event.
- **`reply_to: []`** is always sent when no reply-to is set.
- **`get` returns more than its TypeScript type** (`segment`, `idempotencyKey`).
- **Warn text typo** "to to" (§1.12).
- **README sample** imports `vEmailId, vEmailEvent` but uses `vOnEmailEventArgs`; the README's
  `example/` `sendManualEmail` indexes `headers` (an object) as an array (`example/convex/example.ts`).
- **The API key is stored in plain text** in `lastOptions` and in each `emailWorkpool` work item's args.
- **Child version:** `resend/rateLimiter` on Convex is 0.3.2 (no `batchWorker` child, no `pendingUpdates`
  table); a bunvex port on the 0.4.2 rate limiter shows one more component and table. A Convex export still
  imports (0.4 only adds), but the component tree differs.

**What cannot be compared without Resend:** every sending path ends in a `fetch` to the hard-coded
`https://api.resend.com/emails/batch`; there is no base-URL option. Upstream tests stub the global `fetch`
(convex-test runs actions in-process). Options for an oracle:
- compare everything up to the request (validation, rows, statuses `waiting`/`queued`, the batcher's timing,
  `lastOptions`, cancellation, cleanups, `get`/`getStatus`), and the webhook path end to end with a locally signed
  svix payload (a known `whsec_` secret and the current timestamp) — no network needed;
- drive `sent`/`failed` by inserting `resendId`s directly, or by a fake Resend reached through an intercepting
  HTTPS proxy both backends trust (Convex's `--convex-http-proxy` and bunvex's `http-proxy.ts` tunnel `https:`
  with `CONNECT`, so this needs a MITM CA in each runtime's trust store — unconfirmed feasible);
- a real call with a bogus key gives Resend's 401 → the permanent-failure path, but needs network and Resend's
  body text is not under our control;
- `User-Agent` differs by design (DV-456).

### 2.4 Rule 5 (no "convex" in shipped code)

Occurrences in resend's shipped code (outside comments and docs), for the owner:

| Where | Occurrence | Kind | Note |
|---|---|---|---|
| `package.json` | name `@convex-dev/resend`; description "A resend component for Convex."; keyword `convex`; `repository`/`homepage`/`bugs` (github.com/convex/resend, `support@convex.dev`) | npm metadata | `@bunvex/resend`, bunvex's own words (Q-2 model) |
| `package.json` dependencies | `@convex-dev/rate-limiter`, `@convex-dev/workpool`; peers `convex`, `convex-helpers` | dependency names | `@bunvex/rate-limiter`, `@bunvex/workpool`, `@bunvex/server`, `@bunvex/values`, `@bunvex/helpers` |
| `src/component/convex.config.ts`; exports `./convex.config`, `./convex.config.js` | file and subpath names | package surface | `bunvex.config.ts`, `./bunvex.config(.js)` (DV-533) |
| `convex.config.ts:2-3`, `lib.ts:10-11,27-28`, `shared.ts:1`, `utils.ts:1`, `src/test.ts:4-5` | module specifiers (`@convex-dev/*`, `convex-helpers`, `convex/server`, `convex/values`) | imports | bunvex packages |
| `src/test.ts:2,18` | `TestConvex` (from `convex-test`) | type identifier | `@bunvex/testing`'s type |
| `src/test.ts:12-15` | doc comment naming `convexTest`, `convex.config.ts`, convex-test | JSDoc of an export | rule 8 (published JSDoc names no Convex) |

No error message, log line, header, URL or exported name contains "convex". Strings name "resend"/"Resend" only.
The outgoing request carries the platform's `User-Agent` (`Convex/1.0` on Convex, `Bunvex/1.0` on bunvex,
DV-456). Component name `resend`, children names and table names have no "convex".


## 3. How bunvex does it

### 3.1 The package

STUDY-183's model, as the other components:
- `components/resend/`, version 0.1.0, with a README naming resend 0.2.10;
- `src/component/{bunvex.config.ts, schema.ts, shared.ts, lib.ts, utils.ts}` and `_generated/`;
- `src/client/index.ts` and `src/test.ts`;
- the children `@bunvex/rate-limiter` (R-2) and `@bunvex/workpool` (twice: `emailWorkpool`, `callbackWorkpool`), as
  regular dependencies; `@bunvex/helpers` for `omit`, `parse` and `literals`.

The export map is STUDY-183's: `.`, `./bunvex.config`, `./bunvex.config.js`, `./_generated/component.js` (Convex
Auth's type import, §1.15), `./test`.

### 3.2 The platform is ready, with three checks

Everything in §1.16 is supported. The build's tests check what no bunvex test exercises yet:
- a sibling component calling `resend`'s `lib.sendEmail` through a handle the app made (Convex Auth's path);
- an index range whose key is `Infinity` (`segment` of a manual email);
- `bunvex deploy` bundling the component's third-party code, if any is kept (R-3, R-4).

A failure is fixed in its own PR, as before.

### 3.3 Written from scratch

It follows §1 with Convex's names, paths, tables, validators, defaults, constants, the request to Resend (URL,
headers, body, idempotency key), the permanent-error rule, the webhook contract, the messages and the log lines, and
keeps the quirks of §2.3 (R-6). The third-party packages are R-3 to R-5:
- `svix`: verification only (R-3);
- the `resend` SDK: not imported by the component (R-4);
- `remeda`: one deep-equality check, written in the package (an internal detail, not observable).

### 3.4 Tests

- **The upstream tests, ported** (§1.13) to `@bunvex/testing`, with its virtual clock. Upstream stubs the global
  `fetch` (convex-test runs actions in the test's process). A bunvex test's actions run in the deployment's own
  realm, where a stub of the test's `fetch` does not reach: R-7.
- **More:** every message and log line of §1.12; the webhook's four Svix failures and a valid signature computed in
  the test; the rank rule for every event type; Convex Auth's two call paths (direct and through a handle, from a
  sibling component); the cleanups past one page.
- **A differential test.** The same app with `@convex-dev/resend` 0.2.10 on Convex's binary and `@bunvex/resend` on
  bunvex, without network:
  - validation errors, the rows after `sendEmail` (`waiting`, then `queued`), `lastOptions`, cancelation, `get`,
    `status`, the cleanups;
  - the webhook route end to end with a payload both sides sign with the same `whsec_` secret: statuses, flags,
    `onEmailEvent`'s arguments, the 201 and the 500s.
  The request to Resend itself is compared by its parts in the unit tests (R-7's stub), not against Convex: both
  backends would need a man-in-the-middle proxy each trusts.
- **Sabotage checks:** the 2-segment lag, the 100-email batch cut, the permanent-status rule, the rank rule, and
  test mode's address check.

### 3.5 The build, in PRs

1. R-7's testing hook, if accepted, in `@bunvex/testing` (its own PR, with its tests).
2. The component and the client, with the ported tests and the differential test.
3. The example (R-8).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| R-2 | `resend`'s child `rateLimiter` is bunvex's rate limiter (0.4.2's shape: its own `batchWorker` child and `pendingUpdates` table), where Convex's 0.2.10 mounts rate-limiter 0.3.2 (neither) | bunvex has one rate limiter, the current one; 0.4 only adds, so a Convex export imports | open |
| R-3 | (if replaced) webhook signatures verified with WebCrypto, not the `svix` package; the same four messages | no third-party code in the component; the bundle stays small | open |

Beyond these, the renames of DV-538, DV-347 and DV-533 (§3.3).

## 4b. Additions

| # | Addition | Why | Decision |
|---|---|---|---|
| R-7 | `@bunvex/testing`: a way for a test to answer the `fetch` calls its deployment's actions make (for example `bunvexTest({ fetch: (request) => Response })`) | convex-test runs actions in the test's process, so stubbing the global `fetch` works there; bunvex's actions run in the deployment's realm, where it does not | open |

## 5. Tests

As §3.4, once built.

## 6. Not verified yet

- How Resend answers a reused `Idempotency-Key` with a different payload (§2.3); it affects no comparison, since
  neither backend reaches Resend in the tests.
- The `failed.error` text of a retried send on Convex's backend: STUDY-199's differential test found `Uncaught
  Error: <message>` and the app's frames for thrown errors; a `fetch` `TypeError` inside a component action is not
  compared.

## 7. Questions for the owner

| # | Question | Recommendation |
|---|---|---|
| R-1 | Pin `get-convex/resend` at `982bc63` (0.2.10) in [upstream.md](../parity/upstream.md#other-repositories); it has no row yet | **Yes.** It is the version Convex Auth v2 asks for (`^0.2.8`) and the latest |
| R-2 | The child rate limiter: bunvex's (0.4.2's shape, one more child and table under `resend/rateLimiter`) or a second, 0.3-shaped rate limiter only for resend (§4) | **Use bunvex's**, recorded as a DV. resend uses one fixed-window `limit` call, the same in both versions; a second rate limiter would be code kept only for an older version |
| R-3 | `svix`: keep the package (it works under Bun, and check-deps allows it), or verify the signature with ~20 lines of WebCrypto, with the same four messages (§1.14) | **Replace it with WebCrypto.** The same messages and HMAC (checked under Bun); no CommonJS dependency to bundle into the app's functions, and nothing third-party inside a component. The only visible difference is the error class's name in a 500's stack, which keeps `WebhookVerificationError` |
| R-4 | The `resend` SDK: Convex's package lists it as a dependency but imports it nowhere; only the README's `sendEmailManually` recipe uses it | **Leave it out.** An app that follows the recipe adds `resend` itself (the README says so); the component sends with `fetch`, as Convex's does |
| R-5 | `remeda` (one `isDeepEqual`) | **Write the check in the package**, keeping its behaviour (an `undefined` key, as it arrives across `runMutation`). Internal, not observable: listed for completeness |
| R-6 | The quirks of §2.3, notably `lastOptions` being global and last-writer-wins: Convex Auth's sends silence an app's `onEmailEvent` until the app's own next send | **Keep them all**, as W-3 for workpool: match Convex, the oracle as judge. The `lastOptions` one is worth an upstream issue; auth's email method (STUDY-191) notes it for apps that use both |
| R-7 | The test hook of §4b: let a test answer its deployment's `fetch` calls, so the ported tests (and any app's) can test an action that calls an API | **Yes**, as an addition (AD) to `@bunvex/testing`, in its own PR before the package. Without it, upstream's client and send tests cannot be ported |
| R-8 | The example: Convex's `example/` sends email through Resend (the SDK for the manual path), with a webhook route and an `onEmailEvent` callback | **Port it as `examples/resend`, after the package**, with the webhook route and the callback. Sending needs `RESEND_API_KEY` (the README says so, as the OpenAI examples do); its e2e test covers the queue, the statuses and a signed webhook without network |

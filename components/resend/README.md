# @bunvex/resend

Email for bunvex through [Resend](https://resend.com): emails queued from your mutations and actions, sent in batches
to Resend's API by a durable background job, with retries and a rate limit, their delivery statuses kept up to date
by Resend's signed webhooks, an `onEmailEvent` mutation of yours run on each event, cancelation, and cleanups. It is
bunvex's version of [`@convex-dev/resend`](https://github.com/get-convex/resend) and **matches `@convex-dev/resend`
0.2.10**: the same client API, component name (`resend`), tables and indexes, function paths, arguments, results,
defaults, request to Resend, webhook handling, messages and log lines, so an app moves by renaming its imports and a
Convex export of the component's data imports unchanged.

It mounts [`@bunvex/rate-limiter`](../rate-limiter) as `rateLimiter` and [`@bunvex/workpool`](../workpool) twice, as
`emailWorkpool` (the batch calls) and `callbackWorkpool` (your `onEmailEvent`).

## Install

```sh
bun add @bunvex/resend
```

```ts
// bunvex/bunvex.config.ts
import { defineApp } from "@bunvex/server";
import resend from "@bunvex/resend/bunvex.config.js";

const app = defineApp();
app.use(resend);
export default app;
```

Set `RESEND_API_KEY` in your deployment's environment (`bunvex env set RESEND_API_KEY re_…`), and
`RESEND_WEBHOOK_SECRET` once the webhook below is set up.

## Send

```ts
import { Resend } from "@bunvex/resend";
import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";

export const resend = new Resend(components.resend, {});

export const sendTestEmail = internalMutation({
  handler: async (ctx) => {
    await resend.sendEmail(ctx, {
      from: "Me <test@mydomain.com>",
      to: "delivered@resend.dev",
      subject: "Hi there",
      html: "This is a test email",
    });
  },
});
```

`sendEmail` stores the email and returns its id at once. A background job collects the emails waiting, about a second
after the first, and sends them to Resend's batch API, at most 100 per call and one call every 600 ms across the
deployment. Each batch carries an idempotency key, so a retried call is not sent twice. A call that fails is retried
with exponential backoff; a status Resend will not accept on a retry (400, 401, 403, 422 and the like) fails its
emails at once.

The email: `from`, `to` (one address or several), `cc`, `bcc`, `replyTo`, `headers` (`{ name, value }[]`), `subject`,
and an `html` and/or `text` body, or a Resend `template: { id, variables? }` (its `subject` then optional). An
`idempotencyKey` dedupes sends: a second `sendEmail` with the same key returns the first email's id and queues
nothing, for as long as that email is kept.

### Options

| Option | Default | |
|---|---|---|
| `apiKey` | `process.env.RESEND_API_KEY` | read when the class is built |
| `webhookSecret` | `process.env.RESEND_WEBHOOK_SECRET` | |
| `testMode` | `true` | only Resend's test addresses may be sent to: `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`, each with an optional `+label`. **Set it to `false` to send to anyone.** |
| `initialBackoffMs` | `30000` | the first retry's wait; then twice as long each time |
| `retryAttempts` | `5` | tries in all before the emails fail |
| `onEmailEvent` | none | a mutation run after each event Resend reports |

The component keeps the options of the last `sendEmail` call: the batches use its API key and retries, and webhook
events run its `onEmailEvent`. Give every `Resend` of an app the same options.

## Webhooks and statuses

In Resend's dashboard, add a webhook to `https://<your deployment's site URL>/resend-webhook` for the `email.*` events,
and set its signing secret as `RESEND_WEBHOOK_SECRET`. Then mount the route:

```ts
// bunvex/http.ts
import { httpRouter } from "@bunvex/server";
import { httpAction } from "./_generated/server";
import { resend } from "./sendEmails";

const http = httpRouter();
http.route({
  path: "/resend-webhook",
  method: "POST",
  handler: httpAction((ctx, req) => resend.handleResendEventWebhook(ctx, req)),
});
export default http;
```

The request's Svix signature is checked (a timestamp within five minutes), the event applied to its email, and the
route answers 201. A request it refuses fails as the HTTP action's error (a 500), and Resend sends it again later.

An email is `waiting` until it is in a batch, `queued` until the batch call returns, then `sent`, and then what Resend
reports: `delivered`, `delivery_delayed`, `bounced` or `failed`; or `cancelled`. A status only moves forward, so a
late `delivered` does not undo a `bounced`. The flags `opened`, `clicked`, `complained`, `bounced`, `failed` and
`deliveryDelayed` record what was seen.

```ts
import { vOnEmailEventArgs } from "@bunvex/resend";

export const resend = new Resend(components.resend, { onEmailEvent: internal.emails.handleEmailEvent });

export const handleEmailEvent = internalMutation({
  args: vOnEmailEventArgs,
  handler: async (ctx, { id, event }) => {
    console.log("Got event", id, event.type);
  },
});
```

`onEmailEvent` runs for every event of a known email, repeated ones included, with the event as validated (fields
the validator does not know removed).

| Method | What it does |
|---|---|
| `sendEmail(ctx, email)` | queues an email: its `EmailId` |
| `status(ctx, id)` | `{ status, errorMessage, bounced, complained, failed, deliveryDelayed, opened, clicked }`, or null |
| `get(ctx, id)` | the whole email, its bodies decoded, with `createdAt`; or null |
| `cancelEmail(ctx, id)` | cancels an email not sent yet; throws `Email has already been sent` otherwise |
| `sendEmailManually(ctx, email, send)` | records an email you send yourself (below) |
| `handleResendEventWebhook(ctx, req)` | the webhook route's handler |
| `defineOnEmailEvent(handler)` | an internal mutation with `vOnEmailEventArgs`, to pass as `onEmailEvent` |

## Sending yourself (attachments)

`sendEmail` sends no attachments. To send one, call Resend yourself (with the `resend` package, which you add to your
app) and let the component keep the record, so the webhooks still apply:

```ts
import { Resend as ResendApi } from "resend";

export const sendWithAttachment = internalAction({
  handler: async (ctx) => {
    await resend.sendEmailManually(ctx, { from, to, subject }, async (emailId) => {
      const { data, error } = await new ResendApi(process.env.RESEND_API_KEY).emails.send(
        { from, to, subject, html, attachments },
        { idempotencyKey: emailId },
      );
      if (error) throw new Error(error.message);
      return data.id;
    });
  },
});
```

## Data retention

Nothing is deleted on its own. Schedule the cleanups from your app's crons:

```ts
// bunvex/crons.ts
import { cronJobs } from "@bunvex/server";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const crons = cronJobs();
crons.interval("remove old emails", { hours: 1 }, internal.crons.cleanupResend);
export default crons;

export const cleanupResend = internalMutation({
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, components.resend.lib.cleanupOldEmails, { olderThan: 7 * 24 * 60 * 60 * 1000 });
    await ctx.scheduler.runAfter(0, components.resend.lib.cleanupAbandonedEmails, {
      olderThan: 30 * 24 * 60 * 60 * 1000,
    });
  },
});
```

`cleanupOldEmails` removes the emails that reached a final state (delivered, bounced, failed, cancelled, or
complained about) before `olderThan` (7 days by default). `cleanupAbandonedEmails` removes every email created before
`olderThan` (30 days by default), whatever its status, including those never sent.

## Test

```ts
import { bunvexTest } from "@bunvex/testing";
import { register } from "@bunvex/resend/test";

const t = bunvexTest({ outboundFetch: () => Response.json({ data: [{ id: "re_123" }] }) });
register(t); // mounted as `resend`, with its rate limiter and pools
```

`outboundFetch` answers the batch calls in place of Resend.

## Differences from Convex's package

- Its names are bunvex's: `bunvex.config.js` for `convex.config.js`.
- Its child `rateLimiter` is bunvex's rate limiter, which has a child and a table more than the version Convex's
  package mounts; a Convex export of the data still imports.
- The webhook's signature is checked by the package itself with Web Crypto, with the same rules and messages as the
  `svix` package Convex's uses (the refusals are `WebhookVerificationError`s). It does not depend on `svix`, `resend`
  or `remeda`.
- The `./test` entry registers the component with `@bunvex/testing` (no `modules`: the harness pushes the
  component's directory, and its children come with it).

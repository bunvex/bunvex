# Resend

`@bunvex/resend`, bunvex's version of [`@convex-dev/resend`](https://github.com/get-convex/resend):

- **Sending** ([emails.ts](bunvex/emails.ts)): `send` queues an email; the component sends it to Resend in a batch,
  within Resend's rate limit, and retries what fails for a while. `cancel` stops one that has not gone out.
- **The webhook** ([http.ts](bunvex/http.ts)): Resend reports what happened to each email (delivered, bounced,
  complained, opened, clicked); the component checks the signature, updates the status, and calls `onEmailEvent`.
- **Your own sends** (`trackSent`): an email your code sent through Resend itself, recorded so its events are heard
  too.
- **Cleanup** ([crons.ts](bunvex/crons.ts)): finished emails go after a week, anything else after a month.

The page sends to Resend's test addresses (`delivered@`, `bounced@`, `complained@resend.dev`), the only ones test
mode accepts.

## Run

```sh
bun install
bun run dev
```

Then, from another terminal in this directory, give the deployment your Resend API key:

```sh
bunx bunvex env set RESEND_API_KEY re_...
```

For the webhook, add an endpoint in Resend's dashboard at `<your deployment's site URL>/resend-webhook`, with the
events you want, and set its signing secret:

```sh
bunx bunvex env set RESEND_WEBHOOK_SECRET whsec_...
```

## Test

```sh
bun test examples/resend
```

The test reaches no network: it cancels what it queues before the batch goes out, and drives the webhook with
payloads it signs itself.
